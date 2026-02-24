import type { AgentAdapter, AgentAdapterCapabilities } from "../core/agent.js";
import type { AgentEventSink, AgentId, AgentTurnRequest, AgentTurnResult } from "../core/types.js";
import type { AgentBackend } from "./backend.js";

export abstract class BaseCodeAgentAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;

  constructor(params: {
    id: AgentId;
    displayName: string;
    backend: AgentBackend;
    capabilities?: Partial<AgentAdapterCapabilities>;
  }) {
    this.id = params.id;
    this.displayName = params.displayName;
    this.backend = params.backend;
    this.capabilities = {
      streaming: params.capabilities?.streaming ?? true,
      transports: params.capabilities?.transports ?? [params.backend.mode],
      supportsCommands: params.capabilities?.supportsCommands ?? true,
      supportsMemoryHints: params.capabilities?.supportsMemoryHints ?? true,
    };
  }

  protected readonly backend: AgentBackend;

  protected abstract prelude(request: AgentTurnRequest, sink: AgentEventSink): Promise<void>;

  protected fallbackText(): string {
    return "任务执行完成，但未生成可读输出。请重试或提供更具体的任务目标。";
  }

  async runTurn(request: AgentTurnRequest, sink: AgentEventSink): Promise<AgentTurnResult> {
    await this.prelude(request, sink);

    const backendRequest = {
      sessionId: request.sessionId,
      prompt: request.prompt,
      messages: request.messages,
      systemDirectives: request.systemDirectives,
    } as {
      sessionId: string;
      prompt: string;
      messages: AgentTurnRequest["messages"];
      systemDirectives: string[];
      metadata?: Record<string, unknown>;
    };
    if (request.metadata) {
      backendRequest.metadata = request.metadata;
    }

    const result = await this.backend.execute(backendRequest, sink);

    const text = result.finalText.trim();
    return {
      finalText: text || this.fallbackText(),
      raw: result.raw,
    };
  }
}
