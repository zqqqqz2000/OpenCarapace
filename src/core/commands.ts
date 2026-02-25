import type { AgentRegistry } from "./agent.js";
import { OpenClawCatalogSkill } from "../integrations/openclaw-skills.js";
import { MemorySkill } from "./memory-skill.js";
import { buildFallbackSessionTitle } from "./session-title.js";
import type { SessionManager, SessionRecord } from "./session.js";
import type { SkillRuntime } from "./skills.js";
import type { ToolRuntime } from "./tools.js";
import type { AgentId } from "./types.js";

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
};

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
    raw === "write" ||
    raw === "standard" ||
    raw === "ws"
  ) {
    return "workspace-write";
  }
  if (
    raw === "danger-full-access" ||
    raw === "danger_full_access" ||
    raw === "danger" ||
    raw === "full" ||
    raw === "full-access" ||
    raw === "unisolated" ||
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
      case "reset": {
        const next = this.deps.sessions.reset(params.sessionId, params.currentAgentId);
        const memory = this.getMemorySkill();
        if (memory) {
          memory.clearSession(params.sessionId);
        }
        this.deps.sessions.setMetadata(params.sessionId, next.agentId, {
          codex_thread_id: "",
          session_name: "",
          session_name_source: "",
        });
        return {
          handled: true,
          finalText: [
            "Session reset complete.",
            `- session: ${next.id}`,
            `- agent: ${next.agentId}`,
            "- codexThread: cleared",
          ].join("\n"),
          agentId: next.agentId,
        };
      }
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
          finalText: this.sessionsText(),
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
      case "grep": {
        return this.runToolCommand(params, "grep", args);
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
      "- /new or /reset: clear current session messages",
      "- /history [n]: show last n messages (default 12)",
      "- /sessions: list recent sessions",
      "- /session: show current session details",
      "- /agent [agentId]: show or switch agent (codex/cloudcode/claude-code)",
      "- /model [name|clear]: show or set model preference for current session",
      "- /depth [low|medium|high|clear]: show or set thinking depth",
      "- /sandbox [read-only|workspace-write|danger-full-access|clear]: set codex sandbox mode",
      "- /isolation: alias of /sandbox",
      "- /skills [catalog n]: list active skills or OpenClaw catalog skills",
      "- /tools: list enabled lightweight tools",
      "- /tool <name> [...args]: run tool by name (grep/skill)",
      '- /grep "<pattern>" [--path <dir-or-file>] [--limit <n>]: workspace text search',
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

  private sessionsText(): string {
    const sessions = this.deps.sessions.list();
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

    return [`Sessions (${sessions.length})`, ...rows].join("\n");
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
    if (!session) {
      return [
        "Current session",
        `- id: ${sessionId}`,
        `- agent: ${currentAgentId}`,
        `- model: ${model}`,
        `- thinkingDepth: ${thinkingDepth}`,
        `- sandbox: ${sandboxMode}`,
        `- codexThread: ${codexThread}`,
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
          "Model preference",
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
      this.deps.sessions.setMetadata(sessionId, currentAgentId, { model: "" });
      return {
        handled: true,
        finalText: `Model preference cleared for session ${sessionId}.`,
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setMetadata(sessionId, currentAgentId, { model });
    return {
      handled: true,
      finalText: `Model preference set.\n- session: ${sessionId}\n- model: ${model}`,
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
          "Thinking depth preference",
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
        this.deps.sessions.setMetadata(sessionId, currentAgentId, { thinking_depth: "" });
        return {
          handled: true,
          finalText: `Thinking depth preference cleared for session ${sessionId}.`,
          agentId: currentAgentId,
        };
      }
      return {
        handled: true,
        finalText: "Invalid depth. Use: /depth low|medium|high|clear",
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setMetadata(sessionId, currentAgentId, {
      thinking_depth: normalized,
    });
    return {
      handled: true,
      finalText: `Thinking depth set.\n- session: ${sessionId}\n- depth: ${normalized}`,
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
          "Codex sandbox mode",
          `- current: ${currentMode}`,
          "Usage: /sandbox <read-only|workspace-write|danger-full-access> | /sandbox clear",
          "Aliases: isolated -> read-only, unisolated -> danger-full-access",
        ].join("\n"),
        agentId: currentAgentId,
      };
    }

    const raw = modeRaw.trim().toLowerCase();
    if (raw === "clear" || raw === "default") {
      this.deps.sessions.setMetadata(sessionId, currentAgentId, { sandbox_mode: "" });
      return {
        handled: true,
        finalText: `Sandbox mode cleared for session ${sessionId}.`,
        agentId: currentAgentId,
      };
    }

    const normalized = normalizeSandboxMode(modeRaw);
    if (!normalized) {
      return {
        handled: true,
        finalText: "Invalid sandbox mode. Use: /sandbox read-only|workspace-write|danger-full-access|clear",
        agentId: currentAgentId,
      };
    }

    this.deps.sessions.setMetadata(sessionId, currentAgentId, {
      sandbox_mode: normalized,
    });
    return {
      handled: true,
      finalText: [
        "Sandbox mode set.",
        `- session: ${sessionId}`,
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
