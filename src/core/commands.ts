import type { AgentRegistry } from "./agent.js";
import { OpenClawCatalogSkill } from "../integrations/openclaw-skills.js";
import { MemorySkill } from "./memory-skill.js";
import type { SessionManager } from "./session.js";
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
    name: head.toLowerCase(),
    args,
    raw: trimmed,
  };
}

export type ConversationCommandServiceDeps = {
  registry: AgentRegistry;
  sessions: SessionManager;
  skills: SkillRuntime;
  tools?: ToolRuntime;
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
      case "new":
      case "reset": {
        const next = this.deps.sessions.reset(params.sessionId, params.currentAgentId);
        return {
          handled: true,
          finalText: `Session reset complete.\n- session: ${next.id}\n- agent: ${next.agentId}`,
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
      "- /new or /reset: clear current session messages",
      "- /history [n]: show last n messages (default 12)",
      "- /sessions: list recent sessions",
      "- /session: show current session details",
      "- /agent [agentId]: show or switch agent (codex/cloudcode/claude-code)",
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
    return [
      "Conversation status",
      `- session: ${sessionId}`,
      `- agent: ${currentAgentId}`,
      `- messages: ${messageCount}`,
      `- updatedAt: ${updated}`,
      `- skills: ${skills.length}`,
      "Hint: use /help to see all commands.",
    ].join("\n");
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

    const rows = sessions.slice(0, 20).map((session, index) => {
      return `${index + 1}. ${session.id} | agent=${session.agentId} | messages=${session.messages.length}`;
    });

    return [`Sessions (${sessions.length})`, ...rows].join("\n");
  }

  private sessionText(sessionId: string, currentAgentId: AgentId): string {
    const session = this.deps.sessions.snapshot(sessionId);
    if (!session) {
      return [
        "Current session",
        `- id: ${sessionId}`,
        `- agent: ${currentAgentId}`,
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
