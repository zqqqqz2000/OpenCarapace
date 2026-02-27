import type { AgentId, ChatMessage, TurnPatch } from "./types";
import type { Skill, SkillAfterTurnContext, SkillBeforeTurnContext } from "./skills";

export type MemoryEntry = {
  sessionId: string;
  at: number;
  userText: string;
  assistantText: string;
};

const TOKEN_SPLIT_RE = /[^a-zA-Z0-9\u4e00-\u9fa5]+/g;

function tokenize(text: string): string[] {
  return text
    .split(TOKEN_SPLIT_RE)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function scoreOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const tokens = tokenize(text);
  let score = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

export class InMemoryMemoryBank {
  private readonly bySession = new Map<string, MemoryEntry[]>();

  append(entry: MemoryEntry): void {
    const list = this.bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    this.bySession.set(entry.sessionId, list);
  }

  search(sessionId: string, query: string, limit = 3): MemoryEntry[] {
    const list = this.bySession.get(sessionId) ?? [];
    if (!list.length) {
      return [];
    }

    const queryTokens = new Set(tokenize(query));
    return [...list]
      .map((entry) => ({
        entry,
        score: scoreOverlap(queryTokens, `${entry.userText} ${entry.assistantText}`),
      }))
      .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  dump(sessionId: string): MemoryEntry[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

export class MemorySkill implements Skill {
  readonly id = "core.memory.session";
  readonly description = "Injects compact memory context and persists turn summaries.";
  readonly appliesTo: AgentId[] | "*" | undefined;

  constructor(
    private readonly bank: InMemoryMemoryBank,
    params?: {
      appliesTo?: AgentId[] | "*";
      maxAssistantChars?: number;
    },
  ) {
    this.appliesTo = params?.appliesTo;
    this.maxAssistantChars = params?.maxAssistantChars ?? 300;
  }

  private readonly maxAssistantChars: number;

  beforeTurn(context: SkillBeforeTurnContext): TurnPatch | void {
    const hits = this.bank.search(context.request.sessionId, context.request.prompt, 3);
    if (!hits.length) {
      return;
    }

    const lines = hits.map((entry, index) => {
      return `${index + 1}. 用户: ${entry.userText}\n   助手: ${entry.assistantText}`;
    });

    return {
      systemDirectives: [
        "使用以下记忆上下文，但只在与当前问题直接相关时使用：",
        lines.join("\n"),
      ],
    };
  }

  afterTurn(context: SkillAfterTurnContext): void {
    const user = [...context.request.messages].reverse().find((message) => message.role === "user");
    const assistant = context.result.finalText;
    if (!user || !assistant.trim()) {
      return;
    }

    const normalizedAssistant = assistant.trim().slice(0, this.maxAssistantChars);
    this.bank.append({
      sessionId: context.request.sessionId,
      at: Date.now(),
      userText: user.content.trim().slice(0, 300),
      assistantText: normalizedAssistant,
    });
  }

  dumpSession(sessionId: string, limit = 10): MemoryEntry[] {
    return [...this.bank.dump(sessionId)]
      .sort((left: MemoryEntry, right: MemoryEntry) => right.at - left.at)
      .slice(0, Math.max(1, limit));
  }

  clearSession(sessionId: string): void {
    this.bank.clear(sessionId);
  }
}

export function messageFromText(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    role,
    content,
    createdAt: Date.now(),
  };
}
