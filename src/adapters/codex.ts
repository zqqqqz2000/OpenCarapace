import { spawn } from "node:child_process";
import { BaseCodeAgentAdapter } from "./base.js";
import type { AgentBackend, BackendRunRequest, BackendRunResult } from "./backend.js";
import { SdkAgentBackend } from "./backend.js";
import { TurnAbortedError, toTurnAbortedError } from "../core/abort.js";
import {
  normalizeSessionTitle,
  type SessionTitleGenerationParams,
  type SessionTitleGenerator,
} from "../core/session-title.js";
import type { AgentEventSink, AgentTurnRequest } from "../core/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (const raw of args) {
    const arg = raw.trim();
    if (!arg) {
      continue;
    }
    if (arg === "{{prompt}}" || arg === "exec" || arg === "resume" || arg === "--json") {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function hasModelOption(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      return true;
    }
  }
  return false;
}

function hasSandboxOption(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--sandbox") {
      return true;
    }
  }
  return false;
}

function resolveSessionMetadata(request: BackendRunRequest): Record<string, unknown> {
  if (!isRecord(request.metadata)) {
    return {};
  }
  const session = request.metadata.session;
  if (!isRecord(session)) {
    return {};
  }
  return session;
}

function resolveSessionString(
  sessionMetadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = sessionMetadata[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

type ThinkingDepth = "low" | "medium" | "high";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

function resolveThinkingDepth(sessionMetadata: Record<string, unknown>): ThinkingDepth | undefined {
  const raw = resolveSessionString(sessionMetadata, "thinking_depth");
  if (!raw) {
    return undefined;
  }
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return undefined;
}

function resolveSandboxMode(sessionMetadata: Record<string, unknown>): CodexSandboxMode | undefined {
  const raw = resolveSessionString(sessionMetadata, "sandbox_mode");
  if (!raw) {
    return undefined;
  }
  if (raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access") {
    return raw;
  }
  return undefined;
}

function collectStringValues(value: unknown, output: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    output.push(normalized);
  }
}

function resolveAttachmentPaths(metadata: BackendRunRequest["metadata"]): string[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const attachmentPaths: string[] = [];
  collectStringValues(metadata.attachmentPaths, attachmentPaths);
  collectStringValues(metadata.attachment_paths, attachmentPaths);
  collectStringValues(metadata.localAttachmentPaths, attachmentPaths);
  collectStringValues(metadata.imagePaths, attachmentPaths);
  collectStringValues(metadata.image_paths, attachmentPaths);
  collectStringValues(metadata.localImagePaths, attachmentPaths);
  return [...new Set(attachmentPaths)];
}

function resolveSteerFlag(metadata: BackendRunRequest["metadata"]): boolean {
  if (!isRecord(metadata)) {
    return false;
  }
  return metadata.steer === true;
}

function resolveVoiceInputOnlyFlag(metadata: BackendRunRequest["metadata"]): boolean {
  if (!isRecord(metadata)) {
    return false;
  }
  return metadata.voice_input_only === true || metadata.telegram_voice_only_input === true;
}

function composePrompt(request: BackendRunRequest, depth?: ThinkingDepth): string {
  const sections: string[] = [];

  if (request.systemDirectives.length > 0) {
    const directives = request.systemDirectives
      .map((directive, index) => `${index + 1}. ${directive.trim()}`)
      .join("\n\n");
    sections.push(
      [
        "System directives (must follow):",
        directives,
      ].join("\n"),
    );
  }

  if (depth) {
    sections.push(`Thinking depth preference: ${depth}. Keep user-visible output concise and actionable.`);
  }

  if (resolveSteerFlag(request.metadata)) {
    sections.push(
      "Steer update: user sent a newer message during an ongoing run. Prioritize the latest user request.",
    );
  }

  if (resolveVoiceInputOnlyFlag(request.metadata)) {
    sections.push(
      "Input mode note: this is a voice-only user input. Understand the voice content and execute the user's intent directly, without asking for manual transcription.",
    );
  }

  const attachmentPaths = resolveAttachmentPaths(request.metadata);
  if (attachmentPaths.length > 0) {
    const lines = attachmentPaths.map((entry, index) => `${index + 1}. ${entry}`);
    sections.push(
      [
        "Attached local file paths (temporary files):",
        ...lines,
        "If the request involves these files, inspect them before responding.",
      ].join("\n"),
    );
  }

  sections.push(["User request:", request.prompt].join("\n"));
  return sections.join("\n\n").trim();
}

type CodexJsonEvent = {
  type?: string;
  [key: string]: unknown;
};

function parseJsonLine(line: string): CodexJsonEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as CodexJsonEvent;
  } catch {
    return null;
  }
}

function composeSessionTitlePrompt(firstUserPrompt: string): string {
  return [
    "System directives (must follow):",
    "1. Thinking depth preference: low.",
    "2. This is a one-shot title generation task.",
    "3. Generate the best concise session title from the user's first question.",
    "4. Output title text only, no explanation, no quotes, no markdown, no numbering.",
    "5. Prefer readable Chinese title around 8-18 chars when input is Chinese.",
    "",
    "User request:",
    firstUserPrompt.trim(),
  ].join("\n");
}

async function runCodexSessionTitle(params: {
  command: string;
  baseArgs: string[];
  model?: string;
  firstUserPrompt: string;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  if (params.abortSignal?.aborted) {
    throw toTurnAbortedError(params.abortSignal.reason, "codex session title aborted before start");
  }

  const args = ["exec", "--json", ...params.baseArgs];
  if (params.model && !hasModelOption(args)) {
    args.push("--model", params.model);
  }
  if (!hasSandboxOption(args)) {
    args.push("--sandbox", "read-only");
  }
  const prompt = composeSessionTitlePrompt(params.firstUserPrompt);
  args.push(prompt);

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  return await new Promise<string | undefined>((resolve, reject) => {
    const child = spawn(params.command, args, {
      cwd: process.cwd(),
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutRaw = "";
    let stderr = "";
    let lineBuffer = "";
    const agentMessages: string[] = [];
    let eventChain = Promise.resolve();
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (abortListener) {
        abortListener();
        abortListener = undefined;
      }
    };

    const safeReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const safeResolve = (title: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(title);
    };

    if (params.abortSignal) {
      const onAbort = () => {
        child.kill("SIGTERM");
        safeReject(toTurnAbortedError(params.abortSignal?.reason, "codex session title aborted"));
      };
      if (params.abortSignal.aborted) {
        onAbort();
        return;
      }
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => {
        params.abortSignal?.removeEventListener("abort", onAbort);
      };
    }

    const handleLine = async (lineRaw: string): Promise<void> => {
      const line = lineRaw.trim();
      if (!line) {
        return;
      }
      const event = parseJsonLine(line);
      if (!event) {
        return;
      }
      if (event.type !== "item.completed") {
        return;
      }
      const item = event.item;
      if (!isRecord(item)) {
        return;
      }
      const itemType = typeof item.type === "string" ? item.type : "";
      const itemText = typeof item.text === "string" ? item.text : "";
      if (itemType !== "agent_message" || !itemText.trim()) {
        return;
      }
      agentMessages.push(itemText.trim());
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutRaw += text;
      lineBuffer += text;
      while (true) {
        const index = lineBuffer.indexOf("\n");
        if (index < 0) {
          break;
        }
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        eventChain = eventChain.then(async () => {
          await handleLine(line);
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      safeReject(error);
    });

    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      try {
        if (lineBuffer.trim()) {
          await handleLine(lineBuffer);
        }
        await eventChain;
      } catch (error) {
        safeReject(error);
        return;
      }

      if (params.abortSignal?.aborted) {
        safeReject(new TurnAbortedError("codex session title aborted"));
        return;
      }
      if (code !== 0) {
        safeReject(
          new Error(
            `codex session title failed (code=${code}): ${stderr.trim() || "unknown error"}`,
          ),
        );
        return;
      }

      const rawTitle = agentMessages.join("\n").trim() || stdoutRaw.trim();
      safeResolve(normalizeSessionTitle(rawTitle));
    });

    child.stdin.end();
  });
}

class CodexSessionTitleGenerator implements SessionTitleGenerator {
  constructor(
    private readonly options: {
      command: string;
      baseArgs: string[];
      model?: string;
    },
  ) {}

  async generateTitle(params: SessionTitleGenerationParams): Promise<string | undefined> {
    const request = {
      command: this.options.command,
      baseArgs: this.options.baseArgs,
      firstUserPrompt: params.firstUserPrompt,
      abortSignal: params.abortSignal,
    } as {
      command: string;
      baseArgs: string[];
      model?: string;
      firstUserPrompt: string;
      abortSignal?: AbortSignal;
    };
    if (this.options.model) {
      request.model = this.options.model;
    }
    return await runCodexSessionTitle(request);
  }
}

class CodexCliSessionBackend implements AgentBackend {
  readonly mode = "cli" as const;

  constructor(
    private readonly options: {
      command: string;
      baseArgs: string[];
    },
  ) {}

  async execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult> {
    if (request.abortSignal?.aborted) {
      throw toTurnAbortedError(request.abortSignal.reason, "codex turn aborted before start");
    }

    const sessionMetadata = resolveSessionMetadata(request);
    const previousThreadId = resolveSessionString(sessionMetadata, "codex_thread_id");
    const preferredModel = resolveSessionString(sessionMetadata, "model");
    const thinkingDepth = resolveThinkingDepth(sessionMetadata);
    const sandboxMode = resolveSandboxMode(sessionMetadata);
    const prompt = composePrompt(request, thinkingDepth);

    const args = ["exec", "--json", ...this.options.baseArgs];
    if (preferredModel && !hasModelOption(args)) {
      args.push("--model", preferredModel);
    }
    if (sandboxMode && !hasSandboxOption(args)) {
      args.push("--sandbox", sandboxMode);
    }
    if (previousThreadId) {
      args.push("resume", previousThreadId, prompt);
    } else {
      args.push(prompt);
    }

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
    };

    return await new Promise<BackendRunResult>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: process.cwd(),
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let stdoutRaw = "";
      let stderr = "";
      let lineBuffer = "";
      let threadId = previousThreadId;
      let usage: unknown = undefined;
      const agentMessages: string[] = [];
      let reasoningNotified = false;
      let eventChain = Promise.resolve();
      let abortListener: (() => void) | undefined;

      const cleanup = () => {
        if (abortListener) {
          abortListener();
          abortListener = undefined;
        }
      };

      const safeReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const safeResolve = (result: BackendRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      if (request.abortSignal) {
        const onAbort = () => {
          child.kill("SIGTERM");
          safeReject(toTurnAbortedError(request.abortSignal?.reason, "codex turn aborted"));
        };
        if (request.abortSignal.aborted) {
          onAbort();
          return;
        }
        request.abortSignal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => {
          request.abortSignal?.removeEventListener("abort", onAbort);
        };
      }

      const handleLine = async (lineRaw: string): Promise<void> => {
        const line = lineRaw.trim();
        if (!line) {
          return;
        }
        const event = parseJsonLine(line);
        if (!event) {
          return;
        }

        const type = typeof event.type === "string" ? event.type : "";
        if (type === "thread.started") {
          const nextThreadId = typeof event.thread_id === "string" ? event.thread_id.trim() : "";
          if (nextThreadId) {
            threadId = nextThreadId;
          }
          return;
        }

        if (type === "turn.completed") {
          if (event.usage !== undefined) {
            usage = event.usage;
          }
          return;
        }

        if (type !== "item.completed") {
          return;
        }

        const item = event.item;
        if (!isRecord(item)) {
          return;
        }
        const itemType = typeof item.type === "string" ? item.type : "";
        const itemText = typeof item.text === "string" ? item.text : "";
        if (!itemText.trim()) {
          return;
        }

        if (itemType === "reasoning") {
          if (!reasoningNotified) {
            reasoningNotified = true;
            await sink({
              type: "command",
              command: {
                name: "progress",
                payload: { text: "Codex 正在思考并执行中。" },
              },
              at: Date.now(),
            });
          }
          return;
        }

        if (itemType === "agent_message") {
          agentMessages.push(itemText);
          await sink({
            type: "delta",
            text: itemText,
            at: Date.now(),
          });
        }
      };

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdoutRaw += text;
        lineBuffer += text;

        while (true) {
          const index = lineBuffer.indexOf("\n");
          if (index < 0) {
            break;
          }
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          eventChain = eventChain.then(async () => {
            await handleLine(line);
          });
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        safeReject(error);
      });

      child.on("close", async (code) => {
        if (settled) {
          return;
        }
        try {
          if (lineBuffer.trim()) {
            await handleLine(lineBuffer);
          }
          await eventChain;
        } catch (error) {
          safeReject(error);
          return;
        }

        if (request.abortSignal?.aborted) {
          safeReject(new TurnAbortedError("codex turn aborted"));
          return;
        }

        if (code !== 0) {
          safeReject(
            new Error(
              `codex cli backend failed (code=${code}): ${stderr.trim() || "unknown error"}`,
            ),
          );
          return;
        }

        const finalText = agentMessages.join("\n\n").trim();
        const sessionMetadata: Record<string, unknown> = threadId
          ? {
              codex_thread_id: threadId,
            }
          : {};
        if (usage !== undefined) {
          sessionMetadata.codex_usage_snapshot = usage;
        }

        const raw = {
          stderr: stderr.trim(),
          stdout: stdoutRaw.trim(),
          code,
          usage,
          sessionMetadata,
        } as {
          stderr: string;
          stdout: string;
          code: number | null;
          usage?: unknown;
          sessionMetadata: Record<string, unknown>;
        };

        safeResolve({
          finalText,
          raw,
        });
      });

      child.stdin.end();
    });
  }
}

export class DeterministicCodexBackend extends SdkAgentBackend {
  constructor() {
    super(async (request, sink) => {
      if (request.abortSignal?.aborted) {
        throw toTurnAbortedError(request.abortSignal.reason, "deterministic codex backend aborted");
      }

      const tips = [
        "正在读取任务上下文...",
        "正在拆分可执行步骤...",
        "正在生成简明结果...",
      ];

      for (const tip of tips) {
        if (request.abortSignal?.aborted) {
          throw toTurnAbortedError(request.abortSignal.reason, "deterministic codex backend aborted");
        }
        await sink({
          type: "command",
          command: {
            name: "progress",
            payload: { text: tip },
          },
          at: Date.now(),
        });
      }

      const shortTask = request.prompt.length > 80 ? `${request.prompt.slice(0, 80)}...` : request.prompt;
      const finalText = [
        "结果",
        `1. 已按任务目标处理：${shortTask}`,
        "2. 已尽量减少额外输出，仅保留可执行信息。",
        "过程",
        "1. 分析输入与上下文。",
        "2. 组织步骤并检查可读性。",
        "下一步",
        "1. 若你愿意，我可以继续给出更细的执行清单。",
      ].join("\n");

      return {
        finalText,
      };
    });
  }
}

export type CodexAdapterOptions = {
  backend?: AgentBackend;
};

export class CodexAgentAdapter extends BaseCodeAgentAdapter {
  constructor(options: CodexAdapterOptions = {}) {
    super({
      id: "codex",
      displayName: "Codex",
      backend: options.backend ?? new DeterministicCodexBackend(),
      capabilities: {
        transports: ["sdk", "cli", "hook"],
        streaming: true,
        supportsCommands: true,
        supportsMemoryHints: true,
      },
    });
  }

  protected async prelude(request: AgentTurnRequest, sink: AgentEventSink): Promise<void> {
    await sink({
      type: "status",
      phase: "thinking",
      message: "Codex 正在理解任务并准备执行路径。",
      at: Date.now(),
    });

    await sink({
      type: "command",
      command: {
        name: "notify",
        payload: {
          text: `收到任务：${request.prompt.slice(0, 80)}${request.prompt.length > 80 ? "..." : ""}`,
        },
      },
      at: Date.now(),
    });
  }
}

export function createCodexCliBackendFromEnv(): AgentBackend | null {
  return createCodexCliBackend();
}

export function createCodexCliBackend(params?: {
  command?: string;
  args?: string[];
}): AgentBackend | null {
  const command = params?.command?.trim();
  if (!command) {
    return null;
  }

  const baseArgs = normalizeBaseArgs((params?.args ?? []).map((part) => part.trim()).filter(Boolean));

  return new CodexCliSessionBackend({
    command,
    baseArgs,
  });
}

export function createCodexSessionTitleGenerator(params?: {
  command?: string;
  args?: string[];
  model?: string;
}): SessionTitleGenerator | null {
  const command = params?.command?.trim();
  if (!command) {
    return null;
  }
  const baseArgs = normalizeBaseArgs((params?.args ?? []).map((part) => part.trim()).filter(Boolean));
  const model = params?.model?.trim();
  const options = {
    command,
    baseArgs,
  } as {
    command: string;
    baseArgs: string[];
    model?: string;
  };
  if (model) {
    options.model = model;
  }
  return new CodexSessionTitleGenerator(options);
}
