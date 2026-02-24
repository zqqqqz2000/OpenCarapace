import type { AgentId, ChatMessage } from "./types.js";

export type SessionRecord = {
  id: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
};

export interface SessionStore {
  get(sessionId: string): SessionRecord | undefined;
  save(record: SessionRecord): void;
  delete(sessionId: string): void;
  list(): SessionRecord[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  save(record: SessionRecord): void {
    this.records.set(record.id, record);
  }

  delete(sessionId: string): void {
    this.records.delete(sessionId);
  }

  list(): SessionRecord[] {
    return [...this.records.values()];
  }

  dump(): SessionRecord[] {
    return this.list();
  }
}

export class SessionManager {
  constructor(private readonly store: SessionStore) {}

  ensure(sessionId: string, agentId: AgentId): SessionRecord {
    const existing = this.store.get(sessionId);
    if (existing) {
      if (existing.agentId !== agentId) {
        throw new Error(
          `session ${sessionId} already bound to agent ${existing.agentId}; requested ${agentId}`,
        );
      }
      return existing;
    }

    const now = Date.now();
    const created: SessionRecord = {
      id: sessionId,
      agentId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      metadata: {},
    };
    this.store.save(created);
    return created;
  }

  appendMessage(sessionId: string, agentId: AgentId, message: ChatMessage): SessionRecord {
    const session = this.ensure(sessionId, agentId);
    const next: SessionRecord = {
      ...session,
      updatedAt: Date.now(),
      messages: [...session.messages, message],
    };
    this.store.save(next);
    return next;
  }

  snapshot(sessionId: string): SessionRecord | undefined {
    return this.store.get(sessionId);
  }

  list(): SessionRecord[] {
    return [...this.store.list()].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  }

  reset(sessionId: string, agentId: AgentId): SessionRecord {
    const now = Date.now();
    const previous = this.store.get(sessionId);
    const next: SessionRecord = {
      id: sessionId,
      agentId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      metadata: { ...(previous?.metadata ?? {}) },
    };
    this.store.save(next);
    return next;
  }

  setAgent(sessionId: string, nextAgentId: AgentId): SessionRecord {
    const previous = this.store.get(sessionId);
    if (!previous) {
      return this.ensure(sessionId, nextAgentId);
    }
    if (previous.agentId === nextAgentId) {
      return previous;
    }
    const now = Date.now();
    const next: SessionRecord = {
      ...previous,
      agentId: nextAgentId,
      messages: [],
      updatedAt: now,
      createdAt: now,
    };
    this.store.save(next);
    return next;
  }

  setMetadata(
    sessionId: string,
    agentId: AgentId,
    patch: Record<string, unknown>,
  ): SessionRecord {
    const session = this.ensure(sessionId, agentId);
    const next: SessionRecord = {
      ...session,
      metadata: {
        ...(session.metadata ?? {}),
        ...patch,
      },
      updatedAt: Date.now(),
    };
    this.store.save(next);
    return next;
  }

  getMetadata(sessionId: string): Record<string, unknown> {
    return { ...(this.store.get(sessionId)?.metadata ?? {}) };
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }
}
