import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BaseCodeAgentAdapter } from "./base.js";
import { HookAgentBackend, type AgentBackend, type BackendRunRequest, type BackendRunResult } from "./backend.js";
import { TurnAbortedError, toTurnAbortedError } from "../core/abort.js";
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
    if (arg === "{{prompt}}" || arg === "-p" || arg === "--print") {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function hasOption(args: string[], longOpt: string, shortOpt?: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === longOpt || (shortOpt && arg === shortOpt)) {
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

function resolveThinkingDepth(sessionMetadata: Record<string, unknown>): ThinkingDepth | undefined {
  const raw = resolveSessionString(sessionMetadata, "thinking_depth");
  if (raw === "low" || raw === "medium" || raw === "high") {
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

function resolveMetadataString(metadata: BackendRunRequest["metadata"], key: string): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const value = metadata[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function decodeProjectKey(projectKey: string | undefined): string | undefined {
  const normalized = projectKey?.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function isSubPath(baseDir: string, candidatePath: string): boolean {
  const relative = path.relative(baseDir, candidatePath);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveExecutionCwd(metadata: BackendRunRequest["metadata"]): string {
  const projectRootRaw = resolveMetadataString(metadata, "project_root_dir");
  if (!projectRootRaw) {
    return process.cwd();
  }
  const projectRoot = path.resolve(projectRootRaw);
  if (!isDirectory(projectRoot)) {
    return process.cwd();
  }

  const projectName =
    resolveMetadataString(metadata, "project_name")
    ?? decodeProjectKey(resolveMetadataString(metadata, "project_key"));
  if (!projectName) {
    return projectRoot;
  }

  const candidate = path.resolve(projectRoot, projectName);
  if (!isSubPath(projectRoot, candidate)) {
    return projectRoot;
  }
  if (!isDirectory(candidate)) {
    return projectRoot;
  }
  return candidate;
}

class ClaudeCliSessionBackend implements AgentBackend {
  readonly mode = "cli" as const;

  constructor(
    private readonly options: {
      command: string;
      baseArgs: string[];
    },
  ) {}

  async execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult> {
    if (request.abortSignal?.aborted) {
      throw toTurnAbortedError(request.abortSignal.reason, "claude turn aborted before start");
    }

    const sessionMetadata = resolveSessionMetadata(request);
    const preferredModel = resolveSessionString(sessionMetadata, "model");
    const effort = resolveThinkingDepth(sessionMetadata);
    const claudeSessionId = resolveSessionString(sessionMetadata, "claude_session_id") ?? randomUUID();
    const prompt = composePrompt(request, effort);

    const args = ["-p", ...this.options.baseArgs];
    if (!hasOption(args, "--session-id")) {
      args.push("--session-id", claudeSessionId);
    }
    if (preferredModel && !hasOption(args, "--model")) {
      args.push("--model", preferredModel);
    }
    if (effort && !hasOption(args, "--effort")) {
      args.push("--effort", effort);
    }
    args.push(prompt);

    const executionCwd = resolveExecutionCwd(request.metadata);
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
    };

    return await new Promise<BackendRunResult>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: executionCwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let stdout = "";
      let stderr = "";
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
          safeReject(toTurnAbortedError(request.abortSignal?.reason, "claude turn aborted"));
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

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        void sink({
          type: "delta",
          text,
          at: Date.now(),
        });
      });

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        safeReject(error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        if (request.abortSignal?.aborted) {
          safeReject(new TurnAbortedError("claude turn aborted"));
          return;
        }
        if (code !== 0) {
          safeReject(
            new Error(
              `claude cli backend failed (code=${code}): ${stderr.trim() || "unknown error"}`,
            ),
          );
          return;
        }
        safeResolve({
          finalText: stdout.trim(),
          raw: {
            stderr: stderr.trim(),
            code,
            sessionMetadata: {
              claude_session_id: claudeSessionId,
            },
          },
        });
      });

      child.stdin.end();
    });
  }
}

export class ClaudeCodeAgentAdapter extends BaseCodeAgentAdapter {
  constructor(backend?: AgentBackend) {
    super({
      id: "claude-code",
      displayName: "Claude Code",
      backend:
        backend ??
        new HookAgentBackend(async () => {
          throw new Error(
            "Claude Code backend is not configured. Set agents.claude_code.cli_command in config.toml.",
          );
        }),
      capabilities: {
        transports: ["sdk", "cli", "hook"],
      },
    });
  }

  protected async prelude(_request: AgentTurnRequest, sink: AgentEventSink): Promise<void> {
    await sink({
      type: "status",
      phase: "thinking",
      message: "Claude Code 正在审阅上下文并准备执行。",
      at: Date.now(),
    });

    await sink({
      type: "command",
      command: {
        name: "progress",
        payload: { text: "Claude Code: 已完成风险检查，准备落地。" },
      },
      at: Date.now(),
    });
  }
}

export function createClaudeCodeCliBackend(params?: {
  command?: string;
  args?: string[];
}): AgentBackend | null {
  const command = params?.command?.trim();
  if (!command) {
    return null;
  }

  return new ClaudeCliSessionBackend({
    command,
    baseArgs: normalizeBaseArgs((params?.args ?? []).map((part) => part.trim()).filter(Boolean)),
  });
}
