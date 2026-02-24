import type { CommandTool, ToolExecutionResult } from "../core/tools.js";
import type { OpenClawSkillDoc } from "../integrations/openclaw-skills.js";

const TOKEN_SPLIT_RE = /[^a-zA-Z0-9\u4e00-\u9fa5]+/g;

function tokenize(text: string): string[] {
  return text
    .split(TOKEN_SPLIT_RE)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function scoreSkill(promptTokens: Set<string>, query: string, doc: OpenClawSkillDoc): number {
  if (promptTokens.size === 0) {
    return 0;
  }
  const nameTokens = tokenize(doc.name);
  const summaryTokens = tokenize(doc.summary);
  const queryLower = query.toLowerCase();

  let score = 0;
  for (const token of nameTokens) {
    if (promptTokens.has(token)) {
      score += 6;
    }
  }
  for (const token of summaryTokens) {
    if (promptTokens.has(token)) {
      score += 2;
    }
  }
  if (queryLower.includes(doc.name.toLowerCase()) || queryLower.includes(doc.id.toLowerCase())) {
    score += 10;
  }
  return score;
}

function renderSkillList(docs: OpenClawSkillDoc[], limit: number): string {
  if (docs.length === 0) {
    return "OpenClaw skill catalog is empty.";
  }
  const lines = docs.slice(0, limit).map((doc, index) => `${index + 1}. ${doc.id} | ${doc.name} | ${doc.summary}`);
  return [
    `OpenClaw skills (${docs.length})`,
    ...lines,
    "Tip: use /skill <keywords> or /skill show <skill-id>",
  ].join("\n");
}

function findSkill(docs: OpenClawSkillDoc[], query: string): OpenClawSkillDoc | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const exact = docs.find((doc) => doc.id.toLowerCase() === normalized || doc.name.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  return docs.find(
    (doc) => doc.id.toLowerCase().includes(normalized) || doc.name.toLowerCase().includes(normalized),
  );
}

function parseShowArgs(args: string[]): { action: "search" | "show"; query: string } {
  const first = args[0]?.trim().toLowerCase();
  if (first === "show" || first === "read") {
    return {
      action: "show",
      query: args.slice(1).join(" ").trim(),
    };
  }
  return {
    action: "search",
    query: args.join(" ").trim(),
  };
}

export function createSkillLookupTool(params: {
  docsProvider: () => OpenClawSkillDoc[];
  maxResults?: number;
  maxSnippetChars?: number;
}): CommandTool {
  const maxResults = Math.max(1, params.maxResults ?? 8);
  const maxSnippetChars = Math.max(200, params.maxSnippetChars ?? 1200);

  return {
    id: "openclaw.skill.lookup",
    name: "skill",
    description: "Search and inspect OpenClaw SKILL.md documents with lexical matching.",
    execute(context): ToolExecutionResult {
      const docs = params.docsProvider();
      if (docs.length === 0) {
        return {
          text: "OpenClaw catalog is not enabled.",
        };
      }

      const parsed = parseShowArgs(context.args);
      if (!parsed.query) {
        return {
          text: renderSkillList(docs, Math.max(10, maxResults)),
        };
      }

      if (parsed.action === "show") {
        const doc = findSkill(docs, parsed.query);
        if (!doc) {
          return {
            text: `Skill not found: ${parsed.query}`,
          };
        }
        const snippet = clipText(doc.content, maxSnippetChars);
        return {
          text: [
            `Skill: ${doc.name}`,
            `- id: ${doc.id}`,
            `- source: ${doc.filePath}`,
            `- summary: ${doc.summary}`,
            "Guidance:",
            snippet,
          ].join("\n"),
        };
      }

      const queryTokens = new Set(tokenize(parsed.query));
      const matches = docs
        .map((doc) => ({ doc, score: scoreSkill(queryTokens, parsed.query, doc) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.doc.name.localeCompare(right.doc.name))
        .slice(0, maxResults)
        .map((item) => item.doc);

      if (matches.length === 0) {
        return {
          text: [
            "No skill matches.",
            `- query: ${parsed.query}`,
            "Tip: run /skill to list available skills.",
          ].join("\n"),
        };
      }

      const lines = matches.map((doc, index) => {
        return `${index + 1}. ${doc.id} | ${doc.name} | ${doc.summary}`;
      });
      return {
        text: [
          `Skill matches (${matches.length} / ${docs.length})`,
          ...lines,
          "Tip: run /skill show <skill-id> for full guidance.",
        ].join("\n"),
      };
    },
  };
}
