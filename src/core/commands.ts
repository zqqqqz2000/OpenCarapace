import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "./agent";
import { OpenClawCatalogSkill } from "../integrations/openclaw-skills";
import {
  DEFAULT_CHANNEL_SESSION_PROJECT_KEY,
  decodeChannelSessionProjectKey,
  parseChannelSessionId,
} from "../channels/session-key";
import { MemorySkill } from "./memory-skill";
import { buildFallbackSessionTitle } from "./session-title";
import type { SessionManager, SessionRecord } from "./session";
import type { SkillRuntime } from "./skills";
import type { ToolRuntime } from "./tools";
import type { AgentId } from "./types";

export type ParsedSlashCommand = {
  name: string;
  args: string[];
  raw: string;
};

export type CommandExecutionParams = {
  sessionId: string;
  currentAgentId: AgentId;
  input: string;
};

export type CommandExecutionResult = {
  handled: boolean;
  finalText?: string;
  agentId?: AgentId;
  sessionId?: string;
};

const SESSION_BRANCH_DELIMITER = "::";

function parseNumber(value: string | undefined, fallback: number, min = 1, max = 100): number {
  const n = Number(value ?? "");
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type UsageMetric = {
  key: string;
  path: string;
  value: unknown;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/,/g, "");
  const percent = normalized.endsWith("%") ? normalized.slice(0, -1) : normalized;
  const n = Number(percent);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return n;
}

function formatPercent(value: number): string {
  const normalized = Math.max(0, value);
  const fixed = normalized.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

function formatCount(value: number): string {
  const rounded = Math.round(value);
  return String(rounded);
}

function collectUsageMetrics(input: unknown, path: string, out: UsageMetric[]): void {
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      collectUsageMetrics(input[index], `${path}[${index}]`, out);
    }
    return;
  }
  if (!isRecord(input)) {
    return;
  }
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    const nextPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value) || isRecord(value)) {
      collectUsageMetrics(value, nextPath, out);
      continue;
    }
    out.push({
      key: key.toLowerCase(),
      path: nextPath.toLowerCase(),
      value,
    });
  }
}

function pickMetricNumber(metrics: UsageMetric[], predicate: (metric: UsageMetric) => boolean): number | undefined {
  for (const metric of metrics) {
    if (!predicate(metric)) {
      continue;
    }
    const n = toFiniteNumber(metric.value);
    if (n === undefined) {
      continue;
    }
    return n;
  }
  return undefined;
}

function formatCodexContextUsage(usage: unknown): string {
  if (!isRecord(usage) && !Array.isArray(usage)) {
    return "(unavailable)";
  }
  const metrics: UsageMetric[] = [];
  collectUsageMetrics(usage, "usage", metrics);
  if (metrics.length === 0) {
    return "(unavailable)";
  }

  const directPercent = pickMetricNumber(
    metrics,
    (metric) =>
      /(context.*(ratio|percent|pct|utili)|context_?(usage|use)_?ratio)/.test(metric.key),
  );
  const used = pickMetricNumber(
    metrics,
    (metric) =>
      /(^input_tokens$|^prompt_tokens$|^input_token_count$|context.*(used|usage|consumed)|used_context)/.test(
        metric.key,
      ),
  );
  const limit = pickMetricNumber(
    metrics,
    (metric) =>
      /(context.*(window|max|limit|total|size)|max_context_tokens|max_input_tokens|input_token_limit|context_window_tokens|token_limit)/.test(
        metric.key,
      ) && !/(week|weekly|5h|hour|day|month|year)/.test(metric.path),
  );

  let percent: number | undefined;
  if (directPercent !== undefined) {
    percent = directPercent <= 1 ? directPercent * 100 : directPercent;
  } else if (used !== undefined && limit !== undefined && limit > 0) {
    percent = (used / limit) * 100;
  }

  if (percent === undefined) {
    if (used !== undefined) {
      return `${formatCount(used)} used (limit unknown)`;
    }
    return "(not reported)";
  }
  if (used !== undefined && limit !== undefined && limit > 0) {
    return `${formatPercent(percent)} (${formatCount(used)}/${formatCount(limit)})`;
  }
  return formatPercent(percent);
}

function formatRelativeShort(timestampMs: number, nowMs = Date.now()): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < minute) {
    return "now";
  }
  if (diffMs < hour) {
    return `${Math.floor(diffMs / minute)}m`;
  }
  if (diffMs < day) {
    return `${Math.floor(diffMs / hour)}h`;
  }
  if (diffMs < week) {
    return `${Math.floor(diffMs / day)}d`;
  }
  if (diffMs < month) {
    return `${Math.floor(diffMs / week)}w`;
  }
  if (diffMs < year) {
    return `${Math.floor(diffMs / month)}mo`;
  }
  return `${Math.floor(diffMs / year)}y`;
}

function resolveSessionDisplayName(session: SessionRecord): string {
  const metadataName =
    typeof session.metadata?.session_name === "string" && session.metadata.session_name.trim()
      ? session.metadata.session_name.trim()
      : "";
  if (metadataName) {
    return metadataName;
  }

  const firstUser = session.messages.find((message) => message.role === "user");
  if (firstUser?.content?.trim()) {
    return buildFallbackSessionTitle(firstUser.content.trim());
  }
  return session.id;
}

function clipSessionListName(name: string, maxChars = 24): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "New Session";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function resolveSessionProjectKey(sessionId: string): string | undefined {
  const parsed = parseChannelSessionId(sessionId);
  if (!parsed) {
    return undefined;
  }
  return parsed.projectKey || DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
}

function resolveWorkspaceName(sessionId: string): string {
  const projectKey = resolveSessionProjectKey(sessionId);
  if (!projectKey) {
    return "default";
  }
  return decodeChannelSessionProjectKey(projectKey);
}

type ThinkingDepth = "low" | "medium" | "high";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

function normalizeThinkingDepth(value: string | undefined): ThinkingDepth | undefined {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "low" || raw === "l" || raw === "1" || raw === "shallow") {
    return "low";
  }
  if (raw === "medium" || raw === "mid" || raw === "m" || raw === "2" || raw === "normal") {
    return "medium";
  }
  if (raw === "high" || raw === "h" || raw === "3" || raw === "deep") {
    return "high";
  }
  return undefined;
}

function normalizeSandboxMode(value: string | undefined): CodexSandboxMode | undefined {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) {
    return undefined;
  }

  if (
    raw === "read-only" ||
    raw === "readonly" ||
    raw === "read_only" ||
    raw === "isolated" ||
    raw === "isolate" ||
    raw === "safe" ||
    raw === "ro"
  ) {
    return "read-only";
  }
  if (
    raw === "workspace-write" ||
    raw === "workspace_write" ||
    raw === "workspace" ||
    raw === "rw" ||
    raw === "write" ||
    raw === "w" ||
    raw === "standard" ||
    raw === "ws"
  ) {
    return "workspace-write";
  }
  if (
    raw === "danger-full-access" ||
    raw === "danger_full_access" ||
    raw === "danger" ||
    raw === "dfa" ||
    raw === "full" ||
    raw === "full-access" ||
    raw === "unisolated" ||
    raw === "unsafe" ||
    raw === "open"
  ) {
    return "danger-full-access";
  }

  return undefined;
}

function tokenizeCommandBody(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized) {
      tokens.push(normalized);
    }
    current = "";
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }

  pushCurrent();
  return tokens;
}

function normalizeSlashCommandName(head: string): string {
  const lower = head.toLowerCase();
  const atIndex = lower.indexOf("@");
  if (atIndex <= 0) {
    return lower;
  }
  return lower.slice(0, atIndex);
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) {
    return null;
  }

  const [head, ...args] = tokenizeCommandBody(withoutSlash);
  if (!head) {
    return null;
  }

  return {
    name: normalizeSlashCommandName(head),
    args,
    raw: trimmed,
  };
}

function stripSessionBranchSuffix(sessionId: string): string {
  const normalized = sessionId.trim();
  const markerIndex = normalized.indexOf(SESSION_BRANCH_DELIMITER);
  if (markerIndex <= 0) {
    return normalized;
  }
  return normalized.slice(0, markerIndex);
}

function buildDerivedSessionId(baseSessionId: string): string {
  return `${baseSessionId}${SESSION_BRANCH_DELIMITER}${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export type ConversationCommandServiceDeps = {
  registry: AgentRegistry;
  sessions: SessionManager;
  skills: SkillRuntime;
  tools?: ToolRuntime;
  isSessionRunning?: (sessionId: string) => boolean;
  cancelSessionTurn?: (sessionId: string, reason?: string) => boolean;
};

export class ConversationCommandService {
  constructor(private readonly deps: ConversationCommandServiceDeps) {}

  execute(params: CommandExecutionParams): CommandExecutionResult {
    const parsed = parseSlashCommand(params.input);
    if (!parsed) {
      return { handled: false };
    }

    if (parsed.name === "command" || parsed.name === "commands") {
      return this.executeCommandHub(parsed.args, params);
    }

    return this.executeByName(parsed.name, parsed.args, params);
  }

  private executeCommandHub(args: string[], params: CommandExecutionParams): CommandExecutionResult {
    const sub = args[0]?.toLowerCase();
    if (!sub || sub === "help" || sub === "list") {
      return {
        handled: true,
        finalText: this.helpText(),
        agentId: params.currentAgentId,
      };
    }
    return {
      handled: true,
      finalText: `Unknown /command subcommand: ${sub}\n\n${this.helpText()}`,
      agentId: params.currentAgentId,
    };
  }

  private executeByName(
    name: string,
    args: string[],
    params: CommandExecutionParams,
  ): CommandExecutionResult {
    switch (name) {
      case "help":
        return {
          handled: true,
          finalText: this.helpText(),
          agentId: params.currentAgentId,
        };
      case "status":
        return {
          handled: true,
          finalText: this.statusText(params.sessionId, params.currentAgentId),
          agentId: params.currentAgentId,
        };
      case "stop":
      case "cancel":
      case "interrupt":
        return this.stopTurnText(params.sessionId, params.currentAgentId);
      case "new":
        return this.startNewSession(params.sessionId, params.currentAgentId);
      case "history": {
        const limit = parseNumber(args[0], 12, 1, 50);
        return {
          handled: true,
          finalText: this.historyText(params.sessionId, limit),
          agentId: params.currentAgentId,
        };
      }
      case "sessions": {
        return {
          handled: true,
          finalText: this.sessionsText(params.sessionId),
          agentId: params.currentAgentId,
        };
      }
      case "running": {
        return {
          handled: true,
          finalText: this.runningText(params.sessionId),
          agentId: params.currentAgentId,
        };
      }
      case "project": {
        return {
          handled: true,
          finalText: this.projectText(params.sessionId, args[0]),
          agentId: params.currentAgentId,
        };
      }
      case "rename": {
        return {
          handled: true,
          finalText: this.renameText(params.sessionId, args[0]),
          agentId: params.currentAgentId,
        };
      }
      case "session": {
        return {
          handled: true,
          finalText: this.sessionText(params.sessionId, params.currentAgentId),
          agentId: params.currentAgentId,
        };
      }
      case "agent": {
        return this.agentText(params.sessionId, params.currentAgentId, args[0]);
      }
      case "model": {
        return this.modelText(params.sessionId, params.currentAgentId, args[0]);
      }
      case "depth":
      case "thinking": {
        return this.thinkingDepthText(params.sessionId, params.currentAgentId, args[0]);
      }
      case "sandbox":
      case "isolation": {
        return this.sandboxText(params.sessionId, params.currentAgentId, args[0]);
      }
      case "skills": {
        return {
          handled: true,
          finalText: this.skillsText(params.currentAgentId, args),
          agentId: params.currentAgentId,
        };
      }
      case "tools": {
        return {
          handled: true,
          finalText: this.toolsText(),
          agentId: params.currentAgentId,
        };
      }
      case "tool": {
        return this.runToolCommand(params, args[0], args.slice(1));
      }
      case "skill": {
        return this.runToolCommand(params, "skill", args);
      }
      case "memory": {
        return this.memoryText(params.sessionId, params.currentAgentId, args);
      }
      case "forget": {
        return this.memoryClearText(params.sessionId, params.currentAgentId);
      }
      default:
        return {
          handled: true,
          finalText: `Unknown command: /${name}\n\n${this.helpText()}`,
          agentId: params.currentAgentId,
        };
    }
  }

  private helpText(): string {
    return [
      "Available commands",
      "- /help: show command list",
      "- /status: show current conversation status",
      "- /stop: interrupt current running turn in this session",
      "- /new: keep current session and switch to a new empty session",
      "- /history [n]: show last n messages (default 12)",
      "- /sessions: list recent sessions",
      '- /running: quick quote current session (for locating running turn)',
      "- /project: show current project and open picker in Telegram",
      "- /rename: pick a session in Telegram then rename it",
      "- /session: show current session details",
      "- /agent [agentId]: show or switch agent (codex/claude-code)",
      "- /model [name|clear]: show or set global model preference",
      "- /depth [low|medium|high|clear]: show or set global thinking depth",
      "- /sandbox [read-only|workspace-write|danger-full-access|clear]: set codex sandbox mode for current workspace",
      "- /isolation: alias of /sandbox",
      "- /skills [catalog n]: list active skills or OpenClaw catalog skills",
      "- /tools: list enabled lightweight tools",
      "- /tool <name> [...args]: run tool by name (skill)",
      "- /skill [keywords|show <id>]: search/list OpenClaw skills",
      "- /memory [show|clear] [n]: inspect or clear memory entries",
      "- /forget: alias of /memory clear",
      "- /commands or /command help: show this list",
    ].join("\n");
  }

  private statusText(sessionId: string, currentAgentId: AgentId): string {
    const session = this.deps.sessions.snapshot(sessionId);
    const messageCount = session?.messages.length ?? 0;
    const updated = session ? new Date(session.updatedAt).toISOString() : "(new session)";
    const skills = this.deps.skills.listApplicable(currentAgentId);
    const metadata = this.deps.sessions.getMetadata(sessionId);
    const model =
      typeof metadata.model === "string" && metadata.model.trim() ? metadata.model.trim() : "(default)";
    const thinkingDepth =
      typeof metadata.thinking_depth === "string" && metadata.thinking_depth.trim()
        ? metadata.thinking_depth.trim()
        : "(default)";
    const sandboxMode =
      typeof metadata.sandbox_mode === "string" && metadata.sandbox_mode.trim()
        ? metadata.sandbox_mode.trim()
        : "(default)";
    const codexThread =
      typeof metadata.codex_thread_id === "string" && metadata.codex_thread_id.trim()
        ? metadata.codex_thread_id.trim()
        : "(none)";
    const claudeConversation =
      typeof metadata.claude_session_id === "string" && metadata.claude_session_id.trim()
        ? metadata.claude_session_id.trim()
        : "(none)";
    const codexUsage = metadata.codex_usage_snapshot;
    const codexContext = formatCodexContextUsage(codexUsage);
    return [
      "Conversation status",
      `- session: ${sessionId}`,
      `- agent: ${currentAgentId}`,
      `- messages: ${messageCount}`,
      `- updatedAt: ${updated}`,
      `- model: ${model}`,
      `- thinkingDepth: ${thinkingDepth}`,
      `- sandbox: ${sandboxMode}`,
      `- codexThread: ${codexThread}`,
      `- claudeConversation: ${claudeConversation}`,
      `- codexContextUsage: ${codexContext}`,
      `- skills: ${skills.length}`,
      "Hint: use /help to see all commands.",
    ].join("\n");
  }

  private stopTurnText(sessionId: string, currentAgentId: AgentId): CommandExecutionResult {
    if (!this.deps.cancelSessionTurn) {
      return {
        handled: true,
        finalText: "Stop command is not available in current runtime.",
        agentId: currentAgentId,
      };
    }
    const canceled = this.deps.cancelSessionTurn(sessionId, `Stopped by /stop in session ${sessionId}`);
    if (!canceled) {
      return {
        handled: true,
        finalText: `No running turn to stop in session ${sessionId}.`,
        agentId: currentAgentId,
      };
    }
    return {
      handled: true,
      finalText: `Stop signal sent.\n- session: ${sessionId}\n- status: interrupting running turn`,
      agentId: currentAgentId,
    };
  }

  private startNewSession(currentSessionId: string, currentAgentId: AgentId): CommandExecutionResult {
    const normalizedCurrentId = currentSessionId.trim();
    const previousSession = this.deps.sessions.snapshot(normalizedCurrentId);
    const previousMetadataName =
      typeof previousSession?.metadata?.session_name === "string"
        ? previousSession.metadata.session_name.trim()
        : "";
    const previousDisplayName = clipSessionListName(
      previousMetadataName
        ? previousMetadataName
        : previousSession && previousSession.messages.length > 0
          ? resolveSessionDisplayName(previousSession)
          : "New Session",
      60,
    );
    const baseSessionId = stripSessionBranchSuffix(normalizedCurrentId) || normalizedCurrentId;

    let nextSessionId = buildDerivedSessionId(baseSessionId);
    let attempts = 0;
    while (this.deps.sessions.snapshot(nextSessionId) && attempts < 5) {
      nextSessionId = buildDerivedSessionId(baseSessionId);
      attempts += 1;
    }

    const next = this.deps.sessions.ensure(nextSessionId, currentAgentId);
    this.deps.sessions.setMetadata(next.id, next.agentId, {
      codex_thread_id: "",
      claude_session_id: "",
      session_name: "",
      session_name_source: "",
    });

    return {
      handled: true,
      sessionId: next.id,
      finalText: [
        "Started a new session.",
        `- previous: ${previousDisplayName}`,
        `- session: ${next.id}`,
        `- agent: ${next.agentId}`,
      ].join("\n"),
      agentId: next.agentId,
    };
  }

  private historyText(sessionId: string, limit: number): string {
    const session = this.deps.sessions.snapshot(sessionId);
    if (!session || session.messages.length === 0) {
      return "History is empty for current session.";
    }

    const rows = session.messages
      .slice(-limit)
      .map((message, index) => {
        const content = message.content.replace(/\s+/g, " ").trim();
        const clipped = content.length > 120 ? `${content.slice(0, 120)}...` : content;
        return `${index + 1}. [${message.role}] ${clipped}`;
      });

    return [`History (last ${rows.length})`, ...rows].join("\n");
  }

  private sessionsText(sessionId: string): string {
    const allSessions = this.deps.sessions.list();
    const scopedProjectKey = resolveSessionProjectKey(sessionId);
    const sessions = scopedProjectKey
      ? allSessions.filter((session) => {
          const itemProject = resolveSessionProjectKey(session.id) ?? DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
          return itemProject === scopedProjectKey;
        })
      : allSessions;
    if (sessions.length === 0) {
      return "No sessions yet.";
    }

    const nowMs = Date.now();
    const rows = sessions.slice(0, 20).map((session, index) => {
      const name = clipSessionListName(resolveSessionDisplayName(session));
      const updated = formatRelativeShort(session.updatedAt, nowMs);
      const running = this.deps.isSessionRunning?.(session.id) === true;
      const marker = running ? "⟳ " : "";
      return `${index + 1}. ${marker}${name} ${updated} <${session.agentId}> x${session.messages.length}`;
    });

    const heading = [`Sessions (${sessions.length})`];
    if (scopedProjectKey) {
      heading.push(`- project: ${decodeChannelSessionProjectKey(scopedProjectKey)}`);
    }
    return [...heading, ...rows].join("\n");
  }

  private runningText(sessionId: string): string {
    const session = this.deps.sessions.snapshot(sessionId);
    const displayName = session ? resolveSessionDisplayName(session) : "New Session";
    const quotedName = clipSessionListName(displayName, 60).replace(/"/g, "“");
    const running = this.deps.isSessionRunning?.(sessionId) === true;
    const scopedProjectKey = resolveSessionProjectKey(sessionId);
    const projectPart = scopedProjectKey
      ? `, project=${decodeChannelSessionProjectKey(scopedProjectKey)}`
      : "";
    return running
      ? `Running quote: "${quotedName}" (session=${sessionId}${projectPart})`
      : `No running turn in current session: "${quotedName}" (session=${sessionId}${projectPart})`;
  }

  private projectText(sessionId: string, requestedProjectRaw: string | undefined): string {
    const projectKey = resolveSessionProjectKey(sessionId);
    const current = projectKey ? decodeChannelSessionProjectKey(projectKey) : "(unbound)";
    if (requestedProjectRaw?.trim()) {
      return [
        "Project selection",
        `- current: ${current}`,
        `- requested: ${requestedProjectRaw.trim()}`,
        "Use /project in Telegram and select from inline buttons.",
      ].join("\n");
    }
    return [
      "Project selection",
      `- current: ${current}`,
      "Use /project in Telegram to choose another project.",
    ].join("\n");
  }

  private renameText(sessionId: string, requestedNameRaw: string | undefined): string {
    const session = this.deps.sessions.snapshot(sessionId);
    const current = session ? resolveSessionDisplayName(session) : "New Session";
    if (requestedNameRaw?.trim()) {
      return [
        "Session rename",
        `- current: ${current}`,
        `- requested: ${requestedNameRaw.trim()}`,
        "Use /rename in Telegram, choose a session, then send the new name.",
      ].join("\n");
    }
    return [
      "Session rename",
      `- current: ${current}`,
      "Use /rename in Telegram, choose a session, then send the new name.",
    ].join("\n");
  }

  private sessionText(sessionId: string, currentAgentId: AgentId): string {
    const session = this.deps.sessions.snapshot(sessionId);
    const metadata = this.deps.sessions.getMetadata(sessionId);
    const model =
      typeof metadata.model === "string" && metadata.model.trim() ? metadata.model.trim() : "(default)";
    const thinkingDepth =
      typeof metadata.thinking_depth === "string" && metadata.thinking_depth.trim()
        ? metadata.thinking_depth.trim()
        : "(default)";
    const sandboxMode =
      typeof metadata.sandbox_mode === "string" && metadata.sandbox_mode.trim()
        ? metadata.sandbox_mode.trim()
        : "(default)";
    const codexThread =
      typeof metadata.codex_thread_id === "string" && metadata.codex_thread_id.trim()
        ? metadata.codex_thread_id.trim()
        : "(none)";
    const claudeConversation =
      typeof metadata.claude_session_id === "string" && metadata.claude_session_id.trim()
        ? metadata.claude_session_id.trim()
        : "(none)";
    if (!session) {
      return [
        "Current session",
        `- id: ${sessionId}`,
        `- agent: ${currentAgentId}`,
        `- model: ${model}`,
        `- thinkingDepth: ${thinkingDepth}`,
        `- sandbox: ${sandboxMode}`,
        `- codexThread: ${codexThread}`,
        `- claudeConversation: ${claudeConversation}`,
        "- state: not initialized yet",
      ].join("\n");
    }

    return [
      "Current session",
      `- id: ${session.id}`,
      `- agent: ${session.agentId}`,
      `- createdAt: ${new Date(session.createdAt).toISOString()}`,
      `- updatedAt: ${new Date(session.updatedAt).toISOString()}`,
      `- messages: ${session.messages.length}`,
      `- model: ${model}`,
      `- thinkingDepth: ${thinkingDepth}`,
      `- sandbox: ${sandboxMode}`,
      `- codexThread: ${codexThread}`,
      `- claudeConversation: ${claudeConversation}`,
    ].join("\n");
  }

  private agentText(
    sessionId: string,
    currentAgentId: AgentId,
    requestedAgentRaw: string | undefined,
  ): CommandExecutionResult {
    if (!requestedAgentRaw) {
      const available = this.deps.registry.list().map((agent) => `- ${agent.id}: ${agent.displayName}`);
      return {
        handled: true,
        finalText: ["Current agent", `- ${currentAgentId}`, "Available agents", ...available].join(
          "\n",
        ),
        agentId: currentAgentId,
      };
    }

    const requestedAgent = requestedAgentRaw.trim() as AgentId;
    const adapter = this.deps.registry.get(requestedAgent);
    if (!adapter) {
      const availableIds = this.deps.registry.list().map((agent) => agent.id).join(", ");
      return {
        handled: true,
        finalText: `Unknown agent: ${requestedAgentRaw}\nAvailable: ${availableIds}`,
        agentId: currentAgentId,
      };
    }

    const next = this.deps.sessions.setAgent(sessionId, requestedAgent);
    return {
      handled: true,
      finalText: [
        "Agent switched",
        `- session: ${sessionId}`,
        `- from: ${currentAgentId}`,
        `- to: ${next.agentId}`,
        "Note: message history was reset for safety.",
      ].join("\n"),
      agentId: next.agentId,
    };
  }

  private modelText(
    sessionId: string,
    currentAgentId: AgentId,
    modelRaw: string | undefined,
  ): CommandExecutionResult {
    const current = this.deps.sessions.getMetadata(sessionId);
    const currentModel =
      typeof current.model === "string" && current.model.trim() ? current.model.trim() : "(default)";

    if (!modelRaw) {
      return {
        handled: true,
        finalText: [
          "Model preference (global)",
          `- current: ${currentModel}`,
          "Usage: /model <name> | /model clear",
        ].join("\n"),
        agentId: currentAgentId,
      };
    }

    const model = modelRaw.trim();
    if (!model) {
      return {
        handled: true,
        finalText: "Usage: /model <name> | /model clear",
        agentId: currentAgentId,
      };
    }

    if (model.toLowerCase() === "clear" || model.toLowerCase() === "default") {
      this.deps.sessions.setGlobalMetadata({ model: "" });
      return {
        handled: true,
        finalText: "Model preference cleared globally.",
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setGlobalMetadata({ model });
    return {
      handled: true,
      finalText: `Model preference set.\n- scope: global\n- model: ${model}`,
      agentId: currentAgentId,
    };
  }

  private thinkingDepthText(
    sessionId: string,
    currentAgentId: AgentId,
    depthRaw: string | undefined,
  ): CommandExecutionResult {
    const current = this.deps.sessions.getMetadata(sessionId);
    const currentDepth =
      typeof current.thinking_depth === "string" && current.thinking_depth.trim()
        ? current.thinking_depth.trim()
        : "(default)";

    if (!depthRaw) {
      return {
        handled: true,
        finalText: [
          "Thinking depth preference (global)",
          `- current: ${currentDepth}`,
          "Usage: /depth <low|medium|high> | /depth clear",
        ].join("\n"),
        agentId: currentAgentId,
      };
    }

    const normalized = normalizeThinkingDepth(depthRaw);
    if (!normalized) {
      const raw = depthRaw.trim().toLowerCase();
      if (raw === "clear" || raw === "default") {
        this.deps.sessions.setGlobalMetadata({ thinking_depth: "" });
        return {
          handled: true,
          finalText: "Thinking depth preference cleared globally.",
          agentId: currentAgentId,
        };
      }
      return {
        handled: true,
        finalText: "Invalid depth. Use: /depth low|medium|high|clear",
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setGlobalMetadata({
      thinking_depth: normalized,
    });
    return {
      handled: true,
      finalText: `Thinking depth set.\n- scope: global\n- depth: ${normalized}`,
      agentId: currentAgentId,
    };
  }

  private sandboxText(
    sessionId: string,
    currentAgentId: AgentId,
    modeRaw: string | undefined,
  ): CommandExecutionResult {
    const current = this.deps.sessions.getMetadata(sessionId);
    const currentMode =
      typeof current.sandbox_mode === "string" && current.sandbox_mode.trim()
        ? current.sandbox_mode.trim()
        : "(default)";

    if (!modeRaw) {
      return {
        handled: true,
        finalText: [
          "Codex sandbox mode (workspace)",
          `- current: ${currentMode}`,
          "Usage: /sandbox <read-only|workspace-write|danger-full-access> | /sandbox clear",
          "Aliases: ro/isolated -> read-only, ws/rw/workspace -> workspace-write, dfa/unisolated/open -> danger-full-access",
        ].join("\n"),
        agentId: currentAgentId,
      };
    }

    const raw = modeRaw.trim().toLowerCase();
    if (raw === "clear" || raw === "default") {
      this.deps.sessions.setWorkspaceMetadata(sessionId, { sandbox_mode: "" });
      return {
        handled: true,
        finalText: [
          "Sandbox mode cleared.",
          `- workspace: ${resolveWorkspaceName(sessionId)}`,
        ].join("\n"),
        agentId: currentAgentId,
      };
    }

    const normalized = normalizeSandboxMode(modeRaw);
    if (!normalized) {
      return {
        handled: true,
        finalText:
          "Invalid sandbox mode. Use: /sandbox read-only|workspace-write|danger-full-access|clear (aliases: ro/ws/dfa, isolated/unisolated/open)",
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setWorkspaceMetadata(sessionId, {
      sandbox_mode: normalized,
    });
    return {
      handled: true,
      finalText: [
        "Sandbox mode set.",
        `- workspace: ${resolveWorkspaceName(sessionId)}`,
        `- sandbox: ${normalized}`,
        currentAgentId === "codex" ? "" : "- note: this applies when agent is codex.",
      ]
        .filter(Boolean)
        .join("\n"),
      agentId: currentAgentId,
    };
  }

  private skillsText(agentId: AgentId, args: string[]): string {
    const sub = args[0]?.toLowerCase();
    if (sub === "catalog" || sub === "market") {
      const limit = parseNumber(args[1], 20, 1, 100);
      return this.skillsCatalogText(limit);
    }

    const skills = this.deps.skills.listApplicable(agentId);
    if (skills.length === 0) {
      return `No skills enabled for agent ${agentId}.`;
    }

    const lines = skills.map((skill, index) => `${index + 1}. ${skill.id} - ${skill.description}`);
    return [`Skills for ${agentId}`, ...lines].join("\n");
  }

  private getMemorySkill(): MemorySkill | undefined {
    return this.deps.skills.listAll().find((skill): skill is MemorySkill => skill instanceof MemorySkill);
  }

  private getOpenClawSkill(): OpenClawCatalogSkill | undefined {
    return this.deps.skills
      .listAll()
      .find((skill): skill is OpenClawCatalogSkill => skill instanceof OpenClawCatalogSkill);
  }

  private toolsText(): string {
    if (!this.deps.tools) {
      return "Tool runtime is not enabled.";
    }
    const tools = this.deps.tools.list();
    if (tools.length === 0) {
      return "No tools enabled.";
    }
    const lines = tools.map((tool, index) => {
      const aliasText =
        tool.aliases && tool.aliases.length > 0 ? `${tool.name} (${tool.aliases.join(", ")})` : tool.name;
      return `${index + 1}. ${aliasText} - ${tool.description}`;
    });
    return [`Tools (${tools.length})`, ...lines, "Hint: /tool <name> [...args]"].join("\n");
  }

  private runToolCommand(
    params: CommandExecutionParams,
    nameRaw: string | undefined,
    args: string[],
  ): CommandExecutionResult {
    const name = nameRaw?.trim().toLowerCase();
    if (!name) {
      return {
        handled: true,
        finalText: [`Usage: /tool <name> [...args]`, this.toolsText()].join("\n\n"),
        agentId: params.currentAgentId,
      };
    }

    if (!this.deps.tools) {
      return {
        handled: true,
        finalText: "Tool runtime is not enabled.",
        agentId: params.currentAgentId,
      };
    }

    if (name === "list") {
      return {
        handled: true,
        finalText: this.toolsText(),
        agentId: params.currentAgentId,
      };
    }

    const result = this.deps.tools.run(name, {
      sessionId: params.sessionId,
      currentAgentId: params.currentAgentId,
      input: params.input,
      args,
      cwd: process.cwd(),
    });
    if (!result) {
      return {
        handled: true,
        finalText: [`Unknown tool: ${name}`, this.toolsText()].join("\n\n"),
        agentId: params.currentAgentId,
      };
    }
    return {
      handled: true,
      finalText: result.text.trim() || "Tool executed with empty output.",
      agentId: params.currentAgentId,
    };
  }

  private skillsCatalogText(limit: number): string {
    const openClaw = this.getOpenClawSkill();
    if (!openClaw) {
      return "OpenClaw catalog is not enabled.";
    }

    const docs = openClaw.listDocs();
    if (docs.length === 0) {
      return "OpenClaw catalog is enabled but empty.";
    }

    const lines = docs.slice(0, limit).map((doc, index) => `${index + 1}. ${doc.name} - ${doc.summary}`);
    return [`OpenClaw skills (${docs.length})`, ...lines].join("\n");
  }

  private memoryClearText(sessionId: string, currentAgentId: AgentId): CommandExecutionResult {
    const memory = this.getMemorySkill();
    if (!memory) {
      return {
        handled: true,
        finalText: "Memory skill is not enabled.",
        agentId: currentAgentId,
      };
    }

    memory.clearSession(sessionId);
    return {
      handled: true,
      finalText: `Memory cleared for session ${sessionId}.`,
      agentId: currentAgentId,
    };
  }

  private memoryText(
    sessionId: string,
    currentAgentId: AgentId,
    args: string[],
  ): CommandExecutionResult {
    const memory = this.getMemorySkill();
    if (!memory) {
      return {
        handled: true,
        finalText: "Memory skill is not enabled.",
        agentId: currentAgentId,
      };
    }

    const action = args[0]?.toLowerCase();
    if (action === "clear") {
      return this.memoryClearText(sessionId, currentAgentId);
    }

    const limitArg = action === "show" ? args[1] : args[0];
    const limit = parseNumber(limitArg, 8, 1, 30);
    const entries = memory.dumpSession(sessionId, limit);

    if (entries.length === 0) {
      return {
        handled: true,
        finalText: "Memory is empty for current session.",
        agentId: currentAgentId,
      };
    }

    const lines = entries.map((entry, index) => {
      return [
        `${index + 1}. ${new Date(entry.at).toISOString()}`,
        `   user: ${entry.userText}`,
        `   assistant: ${entry.assistantText}`,
      ].join("\n");
    });

    return {
      handled: true,
      finalText: [`Memory (latest ${entries.length})`, ...lines].join("\n"),
      agentId: currentAgentId,
    };
  }
}
