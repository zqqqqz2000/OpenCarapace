import type { AgentEventSink, AgentId, AgentTurnRequest, AgentTurnResult } from "./types.js";

export type AgentAdapterCapabilities = {
  streaming: boolean;
  transports: Array<"sdk" | "cli" | "hook">;
  supportsCommands: boolean;
  supportsMemoryHints: boolean;
};

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;
  runTurn(request: AgentTurnRequest, sink: AgentEventSink): Promise<AgentTurnResult>;
}

export class AgentRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: AgentId): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`agent adapter not found: ${id}`);
    }
    return adapter;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
