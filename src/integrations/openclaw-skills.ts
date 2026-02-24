import fs from "node:fs";
import path from "node:path";
import type { Skill, SkillBeforeTurnContext } from "../core/skills.js";
import type { AgentId, TurnPatch } from "../core/types.js";

const TOKEN_SPLIT_RE = /[^a-zA-Z0-9\u4e00-\u9fa5]+/g;
const DEFAULT_MAX_DOCS = 200;

export type OpenClawSkillDoc = {
  id: string;
  name: string;
  filePath: string;
  summary: string;
  content: string;
};

type ParsedMarkdownSkill = {
  name: string;
  summary: string;
  content: string;
};

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

function sanitizeSkillDocId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function parseFrontmatterBlock(input: string): { body: string; fields: Record<string, string> } {
  if (!input.startsWith("---\n")) {
    return { body: input, fields: {} };
  }
  const end = input.indexOf("\n---\n", 4);
  if (end < 0) {
    return { body: input, fields: {} };
  }
  const header = input.slice(4, end);
  const body = input.slice(end + 5);
  const fields: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) {
      continue;
    }
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!key || !value) {
      continue;
    }
    fields[key] = value;
  }

  return { body, fields };
}

function parseSkillMarkdown(markdown: string): ParsedMarkdownSkill {
  const { body, fields } = parseFrontmatterBlock(markdown.trim());
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let heading = fields.title || fields.name || "";
  if (!heading) {
    const headingLine = lines.find((line) => line.startsWith("#"));
    heading = headingLine ? headingLine.replace(/^#+\s*/, "").trim() : "";
  }
  if (!heading) {
    heading = "Unnamed skill";
  }

  const plainLines = lines
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/\[(.*?)\]\((.*?)\)/g, "$1").trim())
    .filter(Boolean);

  const summary =
    fields.description ||
    plainLines.find((line) => line.length >= 16) ||
    plainLines[0] ||
    "Skill guidance loaded from SKILL.md";

  const content = plainLines.join("\n");
  return {
    name: heading,
    summary,
    content: content || summary,
  };
}

function findSkillFilesInRoot(rootDir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) {
    return results;
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.depth > 4) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name.toUpperCase() === "SKILL.MD") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function resolveDefaultOpenClawSkillRoots(): string[] {
  const roots = new Set<string>();
  const sibling = path.resolve(process.cwd(), "../openclaw/skills");
  if (fs.existsSync(sibling)) {
    roots.add(sibling);
  }

  return [...roots];
}

export function loadOpenClawSkillDocs(params?: {
  roots?: string[];
  maxDocs?: number;
  allowEnvDefaults?: boolean;
}): OpenClawSkillDoc[] {
  const roots =
    params?.roots && params.roots.length > 0
      ? params.roots
      : params?.allowEnvDefaults === false
        ? []
        : resolveDefaultOpenClawSkillRoots();
  const maxDocs = Math.max(1, params?.maxDocs ?? DEFAULT_MAX_DOCS);
  const docs: OpenClawSkillDoc[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!root) {
      continue;
    }
    const files = findSkillFilesInRoot(root).sort((a, b) => a.localeCompare(b));
    for (const filePath of files) {
      if (docs.length >= maxDocs) {
        return docs;
      }
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const parsed = parseSkillMarkdown(content);
      docs.push({
        id: sanitizeSkillDocId(parsed.name),
        name: parsed.name,
        filePath,
        summary: parsed.summary,
        content: parsed.content,
      });
    }
  }

  return docs;
}

function scoreSkill(promptTokens: Set<string>, prompt: string, doc: OpenClawSkillDoc): number {
  if (promptTokens.size === 0) {
    return 0;
  }
  const nameTokens = tokenize(doc.name);
  const summaryTokens = tokenize(doc.summary);
  const promptLower = prompt.toLowerCase();

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
  if (promptLower.includes(doc.name.toLowerCase())) {
    score += 10;
  }
  return score;
}

export type OpenClawCatalogSkillOptions = {
  appliesTo?: AgentId[] | "*";
  maxSelectedSkills?: number;
  maxSnippetChars?: number;
};

export class OpenClawCatalogSkill implements Skill {
  readonly id = "openclaw.catalog.injector";
  readonly description = "Injects relevant OpenClaw SKILL.md guidance based on user intent.";
  readonly appliesTo: AgentId[] | "*" | undefined;

  private readonly maxSelectedSkills: number;
  private readonly maxSnippetChars: number;
  private readonly docsById = new Map<string, OpenClawSkillDoc>();
  private readonly docs: OpenClawSkillDoc[];

  constructor(docs: OpenClawSkillDoc[], options?: OpenClawCatalogSkillOptions) {
    this.docs = [...docs];
    for (const doc of this.docs) {
      this.docsById.set(doc.id, doc);
    }
    this.appliesTo = options?.appliesTo;
    this.maxSelectedSkills = Math.max(1, options?.maxSelectedSkills ?? 2);
    this.maxSnippetChars = Math.max(240, options?.maxSnippetChars ?? 800);
  }

  listDocs(): OpenClawSkillDoc[] {
    return [...this.docs];
  }

  beforeTurn(context: SkillBeforeTurnContext): TurnPatch | void {
    if (this.docs.length === 0) {
      return;
    }
    const prompt = context.request.prompt.trim();
    if (!prompt) {
      return;
    }

    const promptTokens = new Set(tokenize(prompt));
    const selected = this.docs
      .map((doc) => ({ doc, score: scoreSkill(promptTokens, prompt, doc) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.doc.name.localeCompare(right.doc.name))
      .slice(0, this.maxSelectedSkills)
      .map((item) => item.doc);

    if (selected.length === 0) {
      return;
    }

    const directives = selected.map((doc, index) => {
      const snippet = clipText(doc.content, this.maxSnippetChars);
      return [
        `${index + 1}. skill: ${doc.name}`,
        `   source: ${doc.filePath}`,
        `   summary: ${doc.summary}`,
        `   guidance:`,
        snippet
          .split("\n")
          .map((line: string) => `   ${line}`)
          .join("\n"),
      ].join("\n");
    });

    return {
      systemDirectives: [
        "参考以下 OpenClaw 技能指南（只使用与当前任务直接相关的内容）：",
        directives.join("\n"),
      ],
      metadata: {
        openclawSelectedSkills: selected.map((doc) => doc.id),
      },
    };
  }
}

export function createOpenClawCatalogSkillFromEnv(
  options?: OpenClawCatalogSkillOptions & { roots?: string[]; allowEnvDefaults?: boolean },
): OpenClawCatalogSkill | null {
  return createOpenClawCatalogSkill({
    ...options,
    allowEnvDefaults: options?.allowEnvDefaults ?? true,
  });
}

export function createOpenClawCatalogSkill(
  options?: OpenClawCatalogSkillOptions & { roots?: string[]; allowEnvDefaults?: boolean },
): OpenClawCatalogSkill | null {
  const loadOptions = {} as {
    roots?: string[];
    allowEnvDefaults?: boolean;
  };
  if (options?.roots) {
    loadOptions.roots = options.roots;
  }
  if (options?.allowEnvDefaults !== undefined) {
    loadOptions.allowEnvDefaults = options.allowEnvDefaults;
  }
  const docs = loadOpenClawSkillDocs(loadOptions);
  if (docs.length === 0) {
    return null;
  }
  return new OpenClawCatalogSkill(docs, options);
}
