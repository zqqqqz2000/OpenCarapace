import { spawn } from "node:child_process";
import type { AgentEventSink, AgentTurnRequest } from "../core/types";
import { TurnAbortedError, toTurnAbortedError } from "../core/abort";

export type BackendMode = "sdk" | "cli" | "hook";

export type BackendRunRequest = {
  sessionId: string;
  prompt: string;
  messages: AgentTurnRequest["messages"];
  systemDirectives: string[];
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type BackendRunResult = {
  finalText: string;
  raw?: unknown;
};

export interface AgentBackend {
  readonly mode: BackendMode;
  execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult>;
}

export class SdkAgentBackend implements AgentBackend {
  readonly mode = "sdk" as const;

  constructor(
    private readonly runner: (
      request: BackendRunRequest,
      sink: AgentEventSink,
    ) => Promise<BackendRunResult>,
  ) {}

  execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult> {
    return this.runner(request, sink);
  }
}

export class HookAgentBackend implements AgentBackend {
  readonly mode = "hook" as const;

  constructor(
    private readonly runner: (
      request: BackendRunRequest,
      sink: AgentEventSink,
    ) => Promise<BackendRunResult>,
  ) {}

  execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult> {
    return this.runner(request, sink);
  }
}

export type CliAgentBackendOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  promptMode?: "stdin" | "arg";
  promptArgToken?: string;
};

export class CliAgentBackend implements AgentBackend {
  readonly mode = "cli" as const;

  constructor(private readonly options: CliAgentBackendOptions) {}

  async execute(request: BackendRunRequest, sink: AgentEventSink): Promise<BackendRunResult> {
    if (request.abortSignal?.aborted) {
      throw toTurnAbortedError(request.abortSignal.reason, "cli backend aborted");
    }

    const promptMode = this.options.promptMode ?? "stdin";
    const promptArgToken = this.options.promptArgToken ?? "{{prompt}}";
    const args = [...(this.options.args ?? [])];

    if (promptMode === "arg") {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === promptArgToken) {
          args[i] = request.prompt;
        }
      }
      if (!args.includes(request.prompt)) {
        args.push(request.prompt);
      }
    }

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.options.env ?? {}),
    };

    return await new Promise<BackendRunResult>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: this.options.cwd,
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
          safeReject(toTurnAbortedError(request.abortSignal?.reason, "cli backend aborted"));
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
          safeReject(new TurnAbortedError("cli backend aborted"));
          return;
        }
        if (code !== 0) {
          safeReject(new Error(`cli backend failed (code=${code}): ${stderr.trim() || "unknown error"}`));
          return;
        }
        safeResolve({
          finalText: stdout.trim(),
          raw: {
            stderr: stderr.trim(),
            code,
          },
        });
      });

      if (promptMode === "stdin") {
        const payload = JSON.stringify({
          prompt: request.prompt,
          sessionId: request.sessionId,
          messages: request.messages,
          systemDirectives: request.systemDirectives,
          metadata: request.metadata,
        });
        child.stdin.write(payload);
      }
      child.stdin.end();
    });
  }
}
