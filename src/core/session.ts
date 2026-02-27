import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CHANNEL_SESSION_PROJECT_KEY,
  parseChannelSessionId,
} from "../channels/session-key";
import type { AgentId, ChatMessage } from "./types";

const SESSION_STORE_LOCK_TIMEOUT_MS = 5000;
const SESSION_STORE_LOCK_RETRY_MS = 20;
const SESSION_STORE_LOCK_STALE_MS = 30_000;
const SESSION_BRANCH_DELIMITER = "::";
const INTERNAL_SCOPE_SESSION_PREFIX = "__oc_scope__:";
const GLOBAL_SCOPE_SESSION_ID = `${INTERNAL_SCOPE_SESSION_PREFIX}global`;
const WORKSPACE_SCOPE_SESSION_PREFIX = `${INTERNAL_SCOPE_SESSION_PREFIX}workspace:`;
const DEFAULT_WORKSPACE_SCOPE_KEY = "default";
const INTERNAL_SCOPE_AGENT_ID = "codex";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSessionBranchSuffix(sessionId: string): string {
  const normalized = sessionId.trim();
  const markerIndex = normalized.indexOf(SESSION_BRANCH_DELIMITER);
  if (markerIndex <= 0) {
    return normalized;
  }
  return normalized.slice(0, markerIndex);
}

function isInternalScopeSessionId(sessionId: string): boolean {
  return sessionId.trim().startsWith(INTERNAL_SCOPE_SESSION_PREFIX);
}

function resolveWorkspaceScopeKey(sessionId: string): string {
  const normalized = stripSessionBranchSuffix(sessionId);
  const parsed = parseChannelSessionId(normalized);
  if (!parsed) {
    return DEFAULT_WORKSPACE_SCOPE_KEY;
  }
  return parsed.projectKey || DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
}

function resolveWorkspaceScopeSessionId(sessionId: string): string {
  return `${WORKSPACE_SCOPE_SESSION_PREFIX}${resolveWorkspaceScopeKey(sessionId)}`;
}

function toChatMessage(input: unknown): ChatMessage | null {
  if (!isRecord(input)) {
    return null;
  }
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const content = typeof input.content === "string" ? input.content : "";
  const createdAt = Number(input.createdAt);
  if (!role || !content.trim() || !Number.isFinite(createdAt)) {
    return null;
  }
  const message: ChatMessage = {
    role: role as ChatMessage["role"],
    content,
    createdAt: Math.floor(createdAt),
  };
  if (isRecord(input.metadata)) {
    message.metadata = { ...input.metadata };
  }
  return message;
}

function toSessionRecord(input: unknown): SessionRecord | null {
  if (!isRecord(input)) {
    return null;
  }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const createdAt = Number(input.createdAt);
  const updatedAt = Number(input.updatedAt);
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  if (!id || !agentId || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    return null;
  }
  const messages = rawMessages
    .map((message) => toChatMessage(message))
    .filter((message): message is ChatMessage => Boolean(message));
  return {
    id,
    agentId: agentId as AgentId,
    createdAt: Math.floor(createdAt),
    updatedAt: Math.floor(updatedAt),
    messages,
    metadata: isRecord(input.metadata) ? { ...input.metadata } : {},
  };
}

export type FileSessionStoreOptions = {
  filePath: string;
  maxSessions?: number;
  autoFlush?: boolean;
};

export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly lockFilePath: string;
  private readonly maxSessions: number;
  private readonly autoFlush: boolean;
  private readonly records = new Map<string, SessionRecord>();

  constructor(options: FileSessionStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.lockFilePath = `${this.filePath}.lock`;
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? 500));
    this.autoFlush = options.autoFlush ?? true;
    this.load();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  save(record: SessionRecord): void {
    this.withFileLock(() => {
      this.mergeFromDiskLocked();
      this.records.set(record.id, {
        ...record,
        messages: [...record.messages],
        metadata: { ...(record.metadata ?? {}) },
      });
      this.prune();
      if (this.autoFlush) {
        this.flushLocked();
      }
    });
  }

  delete(sessionId: string): void {
    this.withFileLock(() => {
      this.mergeFromDiskLocked();
      this.records.delete(sessionId);
      if (this.autoFlush) {
        this.flushLocked();
      }
    });
  }

  list(): SessionRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      messages: [...record.messages],
      metadata: { ...(record.metadata ?? {}) },
    }));
  }

  flush(): void {
    this.withFileLock(() => {
      this.mergeFromDiskLocked();
      this.prune();
      this.flushLocked();
    });
  }

  private load(): void {
    for (const record of this.readRecordsFromDisk()) {
      this.records.set(record.id, record);
    }
    this.prune();
  }

  private readRecordsFromDisk(): SessionRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return [];
    }

    const rawSessions = (() => {
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (isRecord(parsed) && Array.isArray(parsed.sessions)) {
        return parsed.sessions;
      }
      return [];
    })();

    const records: SessionRecord[] = [];
    for (const entry of rawSessions) {
      const record = toSessionRecord(entry);
      if (!record) {
        continue;
      }
      records.push(record);
    }
    return records;
  }

  private mergeFromDiskLocked(): void {
    const external = this.readRecordsFromDisk();
    for (const record of external) {
      const current = this.records.get(record.id);
      if (!current || record.updatedAt >= current.updatedAt) {
        this.records.set(record.id, record);
      }
    }
  }

  private flushLocked(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify(
      {
        version: 1,
        sessions: this.list(),
      },
      null,
      2,
    );
    const tempFilePath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tempFilePath, payload, "utf-8");
    fs.renameSync(tempFilePath, this.filePath);
  }

  private withFileLock<T>(work: () => T): T {
    const directory = path.dirname(this.lockFilePath);
    fs.mkdirSync(directory, { recursive: true });
    const startedAt = Date.now();
    while (true) {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(this.lockFilePath, "wx");
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "EEXIST") {
          throw error;
        }
        this.tryClearStaleLock();
        if (Date.now() - startedAt >= SESSION_STORE_LOCK_TIMEOUT_MS) {
          throw new Error(`timed out acquiring session store lock: ${this.lockFilePath}`);
        }
        this.waitSync(SESSION_STORE_LOCK_RETRY_MS);
        continue;
      }

      try {
        return work();
      } finally {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
        }
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          // Ignore lock cleanup failures.
        }
      }
    }
  }

  private tryClearStaleLock(): void {
    try {
      const stat = fs.statSync(this.lockFilePath);
      if (Date.now() - stat.mtimeMs >= SESSION_STORE_LOCK_STALE_MS) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch {
      // Lock disappeared or stat/unlink failed; next loop retry will handle it.
    }
  }

  private waitSync(milliseconds: number): void {
    const deadline = Date.now() + Math.max(1, Math.floor(milliseconds));
    while (Date.now() < deadline) {
      // Busy wait because FileSessionStore APIs are synchronous.
    }
  }

  private prune(): void {
    if (this.records.size <= this.maxSessions) {
      return;
    }
    const sorted = [...this.records.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
    this.records.clear();
    for (const record of sorted.slice(0, this.maxSessions)) {
      this.records.set(record.id, record);
    }
  }
}

export class SessionManager {
  constructor(private readonly store: SessionStore) {}

  private readMetadata(recordId: string): Record<string, unknown> {
    return { ...(this.store.get(recordId)?.metadata ?? {}) };
  }

  private setScopedMetadata(recordId: string, patch: Record<string, unknown>): SessionRecord {
    const now = Date.now();
    const existing = this.store.get(recordId);
    const next: SessionRecord = existing
      ? {
          ...existing,
          metadata: {
            ...(existing.metadata ?? {}),
            ...patch,
          },
          updatedAt: now,
        }
      : {
          id: recordId,
          agentId: INTERNAL_SCOPE_AGENT_ID,
          createdAt: now,
          updatedAt: now,
          messages: [],
          metadata: { ...patch },
        };
    this.store.save(next);
    return next;
  }

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
    return [...this.store.list()]
      .filter((session) => !isInternalScopeSessionId(session.id))
      .sort(
        (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
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

  setGlobalMetadata(patch: Record<string, unknown>): SessionRecord {
    return this.setScopedMetadata(GLOBAL_SCOPE_SESSION_ID, patch);
  }

  setWorkspaceMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord {
    return this.setScopedMetadata(resolveWorkspaceScopeSessionId(sessionId), patch);
  }

  getGlobalMetadata(): Record<string, unknown> {
    return this.readMetadata(GLOBAL_SCOPE_SESSION_ID);
  }

  getWorkspaceMetadata(sessionId: string): Record<string, unknown> {
    return this.readMetadata(resolveWorkspaceScopeSessionId(sessionId));
  }

  getMetadata(sessionId: string): Record<string, unknown> {
    const sessionMetadata = this.readMetadata(sessionId);
    const workspaceMetadata = this.getWorkspaceMetadata(sessionId);
    const globalMetadata = this.getGlobalMetadata();

    const merged: Record<string, unknown> = {
      ...sessionMetadata,
    };
    if (Object.prototype.hasOwnProperty.call(workspaceMetadata, "sandbox_mode")) {
      merged.sandbox_mode = workspaceMetadata.sandbox_mode;
    }
    if (Object.prototype.hasOwnProperty.call(globalMetadata, "model")) {
      merged.model = globalMetadata.model;
    }
    if (Object.prototype.hasOwnProperty.call(globalMetadata, "thinking_depth")) {
      merged.thinking_depth = globalMetadata.thinking_depth;
    }
    return merged;
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }
}
