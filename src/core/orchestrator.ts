import type { AgentAdapter } from "./agent.js";
import { AgentRegistry } from "./agent.js";
import { ConversationCommandService } from "./commands.js";
import { HookBus } from "./hooks.js";
import { isTurnAbortedError, toTurnAbortedError } from "./abort.js";
import type { Skill } from "./skills.js";
import { SkillRuntime } from "./skills.js";
import { ToolRuntime } from "./tools.js";
import { buildFallbackSessionTitle, normalizeSessionTitle, type SessionTitleGenerator } from "./session-title.js";
import type { SessionStore } from "./session.js";
import { InMemorySessionStore, SessionManager } from "./session.js";
import {
  type AgentId,
  type AgentEvent,
  type AgentTurnRequest,
  type ChatMessage,
  type ChatTurnParams,
  type ChatTurnResult,
} from "./types.js";
import { ReadabilityPolicy } from "./ux-policy.js";

function now(): number {
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userMessage(input: string): ChatMessage {
  return {
    role: "user",
    content: input,
    createdAt: now(),
  };
}

function assistantMessage(content: string): ChatMessage {
  return {
    role: "assistant",
    content,
    createdAt: now(),
  };
}

export type ChatOrchestratorDeps = {
  registry?: AgentRegistry;
  skillRuntime?: SkillRuntime;
  toolRuntime?: ToolRuntime;
  hooks?: HookBus;
  sessionTitleGenerator?: SessionTitleGenerator;
  sessionStore?: SessionStore;
  readabilityPolicy?: ReadabilityPolicy;
  commandService?: ConversationCommandService;
  defaultAgentId?: AgentId;
};

export class ChatOrchestrator {
  readonly registry: AgentRegistry;
  readonly skills: SkillRuntime;
  readonly hooks: HookBus;
  readonly tools: ToolRuntime;
  readonly sessions: SessionManager;
  readonly readability: ReadabilityPolicy;
  readonly commands: ConversationCommandService;
  private readonly sessionTitleGenerator: SessionTitleGenerator | null;

  private readonly sessionChains = new Map<string, Promise<ChatTurnResult>>();
  private readonly runningTurns = new Map<string, AbortController>();
  private readonly defaultAgentId: AgentId;

  constructor(deps: ChatOrchestratorDeps = {}) {
    this.registry = deps.registry ?? new AgentRegistry();
    this.skills = deps.skillRuntime ?? new SkillRuntime();
    this.tools = deps.toolRuntime ?? new ToolRuntime();
    this.hooks = deps.hooks ?? new HookBus();
    this.sessions = new SessionManager(deps.sessionStore ?? new InMemorySessionStore());
    this.readability = deps.readabilityPolicy ?? new ReadabilityPolicy();
    this.sessionTitleGenerator = deps.sessionTitleGenerator ?? null;
    this.defaultAgentId = deps.defaultAgentId ?? this.registry.list()[0]?.id ?? "codex";
    this.commands =
      deps.commandService ??
      new ConversationCommandService({
        registry: this.registry,
        sessions: this.sessions,
        skills: this.skills,
        tools: this.tools,
        isSessionRunning: (sessionId) => this.isTurnRunning(sessionId),
      });
  }

  registerAgent(adapter: AgentAdapter): this {
    this.registry.register(adapter);
    return this;
  }

  registerSkill(skill: Skill): this {
    this.skills.register(skill);
    return this;
  }

  async chat(params: ChatTurnParams): Promise<ChatTurnResult> {
    const initialAgentId =
      params.agentId ?? this.sessions.snapshot(params.sessionId)?.agentId ?? this.resolveDefaultAgentId();

    const commandResult = this.commands.execute({
      sessionId: params.sessionId,
      currentAgentId: initialAgentId,
      input: params.input,
    });
    if (commandResult.handled) {
      return await this.emitCommandTurn(
        params,
        commandResult.agentId ?? initialAgentId,
        commandResult.finalText,
      );
    }

    const previous = this.sessionChains.get(params.sessionId) ?? Promise.resolve({
      agentId: initialAgentId,
      sessionId: params.sessionId,
      finalText: "",
      events: [],
    });

    const current = previous
      .catch(() => {
        return {
          agentId: initialAgentId,
          sessionId: params.sessionId,
          finalText: "",
          events: [],
        } satisfies ChatTurnResult;
      })
      .then(() => this.chatUnsafe(params));

    this.sessionChains.set(params.sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionChains.get(params.sessionId) === current) {
        this.sessionChains.delete(params.sessionId);
      }
    }
  }

  cancelRunningTurn(sessionId: string, reason?: string): boolean {
    const controller = this.runningTurns.get(sessionId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(
      toTurnAbortedError(reason ?? `Turn interrupted for session ${sessionId}`, "turn interrupted"),
    );
    return true;
  }

  isTurnRunning(sessionId: string): boolean {
    const controller = this.runningTurns.get(sessionId);
    return Boolean(controller && !controller.signal.aborted);
  }

  private async chatUnsafe(params: ChatTurnParams): Promise<ChatTurnResult> {
    const sessionAbort = new AbortController();
    const cleanupExternalAbort = this.bindExternalAbort(params.abortSignal, sessionAbort);
    this.runningTurns.set(params.sessionId, sessionAbort);

    const ensureNotAborted = () => {
      if (sessionAbort.signal.aborted) {
        throw toTurnAbortedError(sessionAbort.signal.reason, "turn aborted");
      }
    };

    try {
      ensureNotAborted();

      const currentAgentId = this.resolveAgentId(params);
      const adapter = this.registry.require(currentAgentId);

      ensureNotAborted();
      this.sessions.appendMessage(params.sessionId, currentAgentId, userMessage(params.input));
      const snapshot = this.sessions.snapshot(params.sessionId);
      if (!snapshot) {
        throw new Error(`session not found after append: ${params.sessionId}`);
      }
      this.maybeScheduleSessionTitle({
        sessionId: params.sessionId,
        agentId: currentAgentId,
        prompt: params.input,
        messages: snapshot.messages,
      });

      const applicableSkills = this.skills.listApplicable(currentAgentId);
      const sessionMetadata = this.sessions.getMetadata(params.sessionId);
      const mergedMetadata: Record<string, unknown> = {
        ...(params.metadata ?? {}),
      };
      if (Object.keys(sessionMetadata).length > 0) {
        mergedMetadata.session = sessionMetadata;
      }

      const baseRequest = {
        agentId: currentAgentId,
        sessionId: params.sessionId,
        prompt: params.input,
        messages: [...snapshot.messages],
        systemDirectives: [],
        skills: this.skills.describe(applicableSkills),
        abortSignal: sessionAbort.signal,
      } as AgentTurnRequest;
      if (Object.keys(mergedMetadata).length > 0) {
        baseRequest.metadata = mergedMetadata;
      }

      const skillPatch = await this.skills.runBeforeTurn(applicableSkills, baseRequest);
      const hookPatch = await this.hooks.runBeforeTurn({ request: baseRequest });

      const request: AgentTurnRequest = {
        ...baseRequest,
        systemDirectives: [
          ...(skillPatch.systemDirectives ?? []),
          ...(hookPatch.systemDirectives ?? []),
        ],
        metadata: {
          ...(baseRequest.metadata ?? {}),
          ...(skillPatch.metadata ?? {}),
          ...(hookPatch.metadata ?? {}),
        },
      };

      const events: AgentEvent[] = [];
      const emit = async (event: AgentEvent) => {
        events.push(event);
        await this.skills.runOnEvent(applicableSkills, request, event);
        await this.hooks.runOnEvent({ request, event });
        if (params.onEvent) {
          await params.onEvent(event);
        }
      };

      await emit({
        type: "status",
        phase: "queued",
        message: "任务已进入队列。",
        at: now(),
      });

      await emit({
        type: "status",
        phase: "running",
        message: `${adapter.displayName} 开始处理请求。`,
        at: now(),
      });

      ensureNotAborted();
      let turn;
      try {
        turn = await adapter.runTurn(request, emit);
      } catch (error) {
        if (sessionAbort.signal.aborted || isTurnAbortedError(error)) {
          await emit({
            type: "status",
            phase: "running",
            message: "当前任务已被中断，正在切换到最新输入。",
            at: now(),
          });
          throw toTurnAbortedError(error, "turn aborted");
        }
        throw error;
      }
      const sessionMetadataPatch = this.extractSessionMetadataPatch(turn.raw);
      if (sessionMetadataPatch) {
        this.sessions.setMetadata(params.sessionId, currentAgentId, sessionMetadataPatch);
      }

      await emit({
        type: "status",
        phase: "finalizing",
        message: "正在整理最终答复。",
        at: now(),
      });

      const readable = this.readability.normalize(turn.finalText);

      await emit({
        type: "result",
        text: readable,
        at: now(),
      });

      await emit({
        type: "status",
        phase: "completed",
        message: "任务完成。",
        at: now(),
      });

      this.sessions.appendMessage(params.sessionId, currentAgentId, assistantMessage(readable));

      const result: ChatTurnResult = {
        agentId: currentAgentId,
        sessionId: params.sessionId,
        finalText: readable,
        rawFinalText: turn.finalText,
        events,
      };

      await this.skills.runAfterTurn(applicableSkills, request, result);
      await this.hooks.runAfterTurn({ request, result });

      return result;
    } finally {
      cleanupExternalAbort();
      if (this.runningTurns.get(params.sessionId) === sessionAbort) {
        this.runningTurns.delete(params.sessionId);
      }
    }
  }

  private resolveDefaultAgentId(): AgentId {
    if (this.registry.get(this.defaultAgentId)) {
      return this.defaultAgentId;
    }
    return this.registry.list()[0]?.id ?? this.defaultAgentId;
  }

  private resolveAgentId(params: ChatTurnParams): AgentId {
    if (params.agentId) {
      return params.agentId;
    }
    return this.sessions.snapshot(params.sessionId)?.agentId ?? this.resolveDefaultAgentId();
  }

  private bindExternalAbort(
    external: AbortSignal | undefined,
    target: AbortController,
  ): () => void {
    if (!external) {
      return () => {};
    }

    const onAbort = () => {
      target.abort(toTurnAbortedError(external.reason, "turn aborted by caller"));
    };

    if (external.aborted) {
      onAbort();
      return () => {};
    }

    external.addEventListener("abort", onAbort, { once: true });
    return () => external.removeEventListener("abort", onAbort);
  }

  private maybeScheduleSessionTitle(params: {
    sessionId: string;
    agentId: AgentId;
    prompt: string;
    messages: ChatMessage[];
  }): void {
    const userMessages = params.messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1) {
      return;
    }
    const metadata = this.sessions.getMetadata(params.sessionId);
    const existingTitle =
      typeof metadata.session_name === "string" && metadata.session_name.trim()
        ? metadata.session_name.trim()
        : "";
    if (existingTitle) {
      return;
    }

    const fallbackTitle = buildFallbackSessionTitle(params.prompt);
    this.sessions.setMetadata(params.sessionId, params.agentId, {
      session_name: fallbackTitle,
      session_name_source: "fallback",
    });
    if (!this.sessionTitleGenerator) {
      return;
    }

    void this.sessionTitleGenerator
      .generateTitle({
        sessionId: params.sessionId,
        agentId: params.agentId,
        firstUserPrompt: params.prompt,
      })
      .then((generated) => {
        if (!generated) {
          return;
        }
        const normalized = normalizeSessionTitle(generated);
        if (!normalized) {
          return;
        }
        this.sessions.setMetadata(params.sessionId, params.agentId, {
          session_name: normalized,
          session_name_source: "codex",
        });
      })
      .catch(() => {
        // best-effort naming: ignore transient title generation failures
      });
  }

  private async emitCommandTurn(
    params: ChatTurnParams,
    agentId: AgentId,
    text: string | undefined,
  ): Promise<ChatTurnResult> {
    const result = this.commandTurn(params.sessionId, agentId, text);
    if (params.onEvent) {
      for (const event of result.events) {
        await params.onEvent(event);
      }
    }
    return result;
  }

  private commandTurn(sessionId: string, agentId: AgentId, text: string | undefined): ChatTurnResult {
    const normalized = this.readability.normalize((text ?? "Command handled.").trim());
    const events: AgentEvent[] = [
      {
        type: "status",
        phase: "running",
        message: "正在执行会话命令。",
        at: now(),
      },
      {
        type: "result",
        text: normalized,
        at: now(),
      },
      {
        type: "status",
        phase: "completed",
        message: "命令执行完成。",
        at: now(),
      },
    ];

    return {
      agentId,
      sessionId,
      finalText: normalized,
      rawFinalText: normalized,
      events,
    };
  }

  private extractSessionMetadataPatch(raw: unknown): Record<string, unknown> | undefined {
    if (!isRecord(raw)) {
      return undefined;
    }
    const metadata = raw.sessionMetadata;
    if (!isRecord(metadata)) {
      return undefined;
    }
    if (Object.keys(metadata).length === 0) {
      return undefined;
    }
    return metadata;
  }
}
