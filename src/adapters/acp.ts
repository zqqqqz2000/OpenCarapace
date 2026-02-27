import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type PermissionOption,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentAdapter, AgentAdapterCapabilities } from "../core/agent";
import { TurnAbortedError, toTurnAbortedError } from "../core/abort";
import type {
  AgentEventSink,
  AgentId,
  AgentTurnRequest,
  AgentTurnResult,
} from "../core/types";

// ---------------------------------------------------------------------------
// Node.js stream → Web Streams API adapters
// ---------------------------------------------------------------------------

function nodeReadableToWeb(readable: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readable.on("data", (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        );
      });
      readable.on("end", () => controller.close());
      readable.on("error", (err) => controller.error(err));
    },
  });
}

function nodeWritableToWeb(writable: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        writable.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        writable.end(resolve);
      });
    },
  });
}

// ---------------------------------------------------------------------------
// SessionUpdate → AgentEvent helpers
// ---------------------------------------------------------------------------

type AnyUpdate = {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  title?: string;
  status?: string;
  entries?: Array<{ title?: string; status?: string }>;
};

function extractTextFromUpdate(update: AnyUpdate): string {
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    if (update.content?.type === "text" && typeof update.content.text === "string") {
      return update.content.text;
    }
  }
  return "";
}

function extractToolLabel(update: AnyUpdate): string | null {
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const title = update.title;
    const status = update.status;
    if (title) {
      return status ? `[${status}] ${title}` : title;
    }
  }
  return null;
}

function formatPermissionRequest(params: RequestPermissionRequest): string {
  const title = (params.toolCall as { title?: string }).title ?? "tool call";
  const optionsList = params.options
    .map((opt: PermissionOption) => `  • ${opt.name} (${opt.kind})`)
    .join("\n");
  return `Permission request: ${title}\n${optionsList}`;
}

// ---------------------------------------------------------------------------
// Per-session ACP state
// ---------------------------------------------------------------------------

type TurnClientRef = {
  /** Mutable slot — swapped in before each turn's prompt() call */
  current: Client | null;
};

type AcpSessionState = {
  acpSessionId: string;
  connection: ClientSideConnection;
  process: ChildProcess;
  /** Shared ref injected into the connection's toClient closure */
  clientRef: TurnClientRef;
};

// ---------------------------------------------------------------------------
// AcpAgentAdapter
// ---------------------------------------------------------------------------

export type AcpAgentAdapterOptions = {
  id: AgentId;
  displayName: string;
  command: string;
  args?: string[];
  cwd?: string;
};

/**
 * AgentAdapter that communicates with an ACP-capable agent process
 * (e.g. claude-acp, codex-acp).
 *
 * Unlike the CLI adapter (one process per turn), this adapter maintains a
 * persistent ClientSideConnection across turns — proper ACP session semantics,
 * stateful context, and bidirectional `requestPermission` RPCs.
 */
export class AcpAgentAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;

  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;

  // sessionId (our orchestrator's) → ACP session state
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(options: AcpAgentAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.capabilities = {
      streaming: true,
      transports: ["sdk"],
      supportsCommands: true,
      supportsMemoryHints: true,
    };
  }

  async runTurn(request: AgentTurnRequest, sink: AgentEventSink): Promise<AgentTurnResult> {
    if (request.abortSignal?.aborted) {
      throw toTurnAbortedError(request.abortSignal.reason, "acp turn aborted before start");
    }

    await sink({
      type: "status",
      phase: "thinking",
      message: `${this.displayName} 正在通过 ACP 连接并处理请求。`,
      at: Date.now(),
    });

    const state = await this.getOrCreateSession(request, sink);

    if (request.abortSignal?.aborted) {
      throw toTurnAbortedError(request.abortSignal.reason, "acp turn aborted before prompt");
    }

    const promptText = buildAcpPromptText(request);
    let finalText = "";

    // A pending promise resolver for the in-flight requestPermission RPC.
    // There is at most one pending permission per session at a time (ACP is sequential).
    let pendingPermission:
      | {
          resolve: (response: RequestPermissionResponse) => void;
          reject: (err: unknown) => void;
        }
      | undefined;

    // Install per-turn client callbacks via the shared mutable ref
    const turnClient: Client = {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update as AnyUpdate;

        const text = extractTextFromUpdate(update);
        if (text) {
          finalText += text;
          await sink({ type: "delta", text, at: Date.now() });
          return;
        }

        const toolLabel = extractToolLabel(update);
        if (toolLabel) {
          await sink({ type: "status", phase: "tooling", message: toolLabel, at: Date.now() });
          return;
        }

        if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
          const titles = update.entries.map((e) => e.title ?? "").filter(Boolean).join(", ");
          if (titles) {
            await sink({ type: "status", phase: "thinking", message: `Plan: ${titles}`, at: Date.now() });
          }
        }
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const permissionToken = randomUUID();
        const description = formatPermissionRequest(params);

        // Emit an ask_user command event so the channel can present the options
        // to the user. The channel should call back with resolvePermission().
        await sink({
          type: "command",
          command: {
            name: "ask_user",
            payload: {
              text: description,
              permissionToken,
              options: params.options,
              toolCall: params.toolCall,
              acpSessionId: params.sessionId,
            },
          },
          at: Date.now(),
        });

        // Block until the user's choice is forwarded back
        return new Promise<RequestPermissionResponse>((resolve, reject) => {
          pendingPermission = { resolve, reject };
        });
      },
    };

    // Swap in this turn's client callbacks
    state.clientRef.current = turnClient;

    // Abort handling: forward cancellation to ACP
    let abortCleanup: (() => void) | undefined;
    const onAbort = async () => {
      try {
        await state.connection.cancel({ sessionId: state.acpSessionId });
      } catch {
        // best-effort
      }
      if (pendingPermission) {
        pendingPermission.reject(new TurnAbortedError("acp turn aborted"));
        pendingPermission = undefined;
      }
    };

    if (request.abortSignal) {
      if (request.abortSignal.aborted) {
        throw toTurnAbortedError(request.abortSignal.reason, "acp turn aborted");
      }
      request.abortSignal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => request.abortSignal?.removeEventListener("abort", onAbort);
    }

    try {
      const response = await state.connection.prompt({
        sessionId: state.acpSessionId,
        prompt: [{ type: "text", text: promptText }],
      });

      if (response.stopReason === "cancelled") {
        throw new TurnAbortedError("acp turn cancelled by agent");
      }

      return {
        finalText: finalText.trim() || `[${this.displayName}] Turn complete (${response.stopReason}).`,
        raw: {
          stopReason: response.stopReason,
          acpSessionId: state.acpSessionId,
          sessionMetadata: { acp_session_id: state.acpSessionId },
        },
      };
    } catch (error) {
      if (request.abortSignal?.aborted || error instanceof TurnAbortedError) {
        throw toTurnAbortedError(error, "acp turn aborted");
      }
      // Invalidate the session on unrecoverable errors so the next turn
      // spawns a fresh connection.
      this.destroySession(request.sessionId);
      throw error;
    } finally {
      state.clientRef.current = null;
      abortCleanup?.();
    }
  }

  /**
   * Terminate and clean up the ACP session for the given sessionId.
   */
  destroySession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }
    this.sessions.delete(sessionId);
    try {
      state.process.kill("SIGTERM");
    } catch {
      // best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async getOrCreateSession(
    request: AgentTurnRequest,
    sink: AgentEventSink,
  ): Promise<AcpSessionState> {
    const existing = this.sessions.get(request.sessionId);
    if (existing && !existing.connection.signal.aborted) {
      return existing;
    }

    // Spawn the ACP agent process
    const child = spawn(this.command, this.args, {
      cwd: this.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child.stdin || !child.stdout) {
      throw new Error(
        `${this.displayName}: failed to spawn ACP process — missing stdio streams`,
      );
    }

    const stream = ndJsonStream(
      nodeWritableToWeb(child.stdin),
      nodeReadableToWeb(child.stdout),
    );

    // A shared mutable ref — the connection closure delegates to whatever
    // client the current turn has installed.
    const clientRef: TurnClientRef = { current: null };

    const connection = new ClientSideConnection((_agent: Agent) => {
      const proxy: Client = {
        requestPermission: (params) => {
          if (!clientRef.current) {
            return Promise.resolve({
              outcome: { outcome: "cancelled" },
            } as RequestPermissionResponse);
          }
          return clientRef.current.requestPermission(params);
        },
        sessionUpdate: (params) => {
          if (!clientRef.current) return Promise.resolve();
          return clientRef.current.sessionUpdate(params);
        },
      };
      return proxy;
    }, stream);

    // Consume stderr silently to prevent unhandled stream errors
    child.stderr?.on("data", (_chunk: Buffer) => {});

    // Clean up our map when the connection closes (process exit / crash)
    connection.signal.addEventListener(
      "abort",
      () => {
        if (this.sessions.get(request.sessionId)?.connection === connection) {
          this.sessions.delete(request.sessionId);
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
      },
      { once: true },
    );

    // ACP handshake
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "open-carapace", version: "0.1.0" },
      clientCapabilities: {},
    });

    // Resolve the working directory for the ACP session
    const metadata = request.metadata as Record<string, unknown> | undefined;
    const projectRootRaw =
      typeof metadata?.project_root_dir === "string" ? metadata.project_root_dir : undefined;
    const sessionCwd = projectRootRaw ?? process.cwd();

    const sessionResp = await connection.newSession({
      cwd: sessionCwd,
      mcpServers: [],
    });

    const state: AcpSessionState = {
      acpSessionId: sessionResp.sessionId,
      connection,
      process: child,
      clientRef,
    };

    this.sessions.set(request.sessionId, state);

    await sink({
      type: "status",
      phase: "running",
      message: `${this.displayName} ACP session started (${sessionResp.sessionId.slice(0, 8)}…).`,
      at: Date.now(),
    });

    return state;
  }
}

// ---------------------------------------------------------------------------
// Prompt composer
// ---------------------------------------------------------------------------

function buildAcpPromptText(request: AgentTurnRequest): string {
  const sections: string[] = [];

  if (request.systemDirectives.length > 0) {
    const directives = request.systemDirectives
      .map((d, i) => `${i + 1}. ${d.trim()}`)
      .join("\n\n");
    sections.push(`System directives (must follow):\n${directives}`);
  }

  sections.push(`User request:\n${request.prompt}`);
  return sections.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createClaudeAcpAdapter(params?: {
  command?: string;
  args?: string[];
  cwd?: string;
}): AcpAgentAdapter | null {
  const command = params?.command?.trim();
  if (!command) return null;
  const opts: AcpAgentAdapterOptions = {
    id: "claude-code",
    displayName: "Claude Code (ACP)",
    command,
    args: params?.args ?? [],
  };
  if (params?.cwd) {
    opts.cwd = params.cwd;
  }
  return new AcpAgentAdapter(opts);
}

export function createCodexAcpAdapter(params?: {
  command?: string;
  args?: string[];
  cwd?: string;
}): AcpAgentAdapter | null {
  const command = params?.command?.trim();
  if (!command) return null;
  const opts: AcpAgentAdapterOptions = {
    id: "codex",
    displayName: "Codex (ACP)",
    command,
    args: params?.args ?? [],
  };
  if (params?.cwd) {
    opts.cwd = params.cwd;
  }
  return new AcpAgentAdapter(opts);
}
