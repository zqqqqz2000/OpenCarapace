import type { AgentAdapter } from "./agent.js";
import { AgentRegistry } from "./agent.js";
import { ConversationCommandService } from "./commands.js";
import { HookBus } from "./hooks.js";
import type { Skill } from "./skills.js";
import { SkillRuntime } from "./skills.js";
import { ToolRuntime } from "./tools.js";
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

  private readonly sessionChains = new Map<string, Promise<ChatTurnResult>>();
  private readonly defaultAgentId: AgentId;

  constructor(deps: ChatOrchestratorDeps = {}) {
    this.registry = deps.registry ?? new AgentRegistry();
    this.skills = deps.skillRuntime ?? new SkillRuntime();
    this.tools = deps.toolRuntime ?? new ToolRuntime();
    this.hooks = deps.hooks ?? new HookBus();
    this.sessions = new SessionManager(deps.sessionStore ?? new InMemorySessionStore());
    this.readability = deps.readabilityPolicy ?? new ReadabilityPolicy();
    this.defaultAgentId = deps.defaultAgentId ?? this.registry.list()[0]?.id ?? "codex";
    this.commands =
      deps.commandService ??
      new ConversationCommandService({
        registry: this.registry,
        sessions: this.sessions,
        skills: this.skills,
        tools: this.tools,
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

  private async chatUnsafe(params: ChatTurnParams): Promise<ChatTurnResult> {
    const currentAgentId = this.resolveAgentId(params);
    const commandResult = this.commands.execute({
      sessionId: params.sessionId,
      currentAgentId,
      input: params.input,
    });
    if (commandResult.handled) {
      const result = this.commandTurn(
        params.sessionId,
        commandResult.agentId ?? currentAgentId,
        commandResult.finalText,
      );
      if (params.onEvent) {
        for (const event of result.events) {
          await params.onEvent(event);
        }
      }
      return result;
    }

    const adapter = this.registry.require(currentAgentId);

    this.sessions.appendMessage(params.sessionId, currentAgentId, userMessage(params.input));
    const snapshot = this.sessions.snapshot(params.sessionId);
    if (!snapshot) {
      throw new Error(`session not found after append: ${params.sessionId}`);
    }

    const applicableSkills = this.skills.listApplicable(currentAgentId);

    const baseRequest = {
      agentId: currentAgentId,
      sessionId: params.sessionId,
      prompt: params.input,
      messages: [...snapshot.messages],
      systemDirectives: [],
      skills: this.skills.describe(applicableSkills),
    } as AgentTurnRequest;
    if (params.metadata) {
      baseRequest.metadata = params.metadata;
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

    const turn = await adapter.runTurn(request, emit);

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
      events,
    };

    await this.skills.runAfterTurn(applicableSkills, request, result);
    await this.hooks.runAfterTurn({ request, result });

    return result;
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
      events,
    };
  }
}
