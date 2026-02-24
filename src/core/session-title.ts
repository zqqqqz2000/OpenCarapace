import type { AgentId } from "./types.js";

export type SessionTitleGenerationParams = {
  sessionId: string;
  agentId: AgentId;
  firstUserPrompt: string;
  abortSignal?: AbortSignal;
};

export interface SessionTitleGenerator {
  generateTitle(params: SessionTitleGenerationParams): Promise<string | undefined>;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeSessionTitle(raw: string, maxChars = 40): string | undefined {
  const firstLine = compactWhitespace(raw.replace(/\r/g, "").split("\n")[0] ?? "");
  if (!firstLine) {
    return undefined;
  }

  const stripped = firstLine
    .replace(/^["'`【\[]+/, "")
    .replace(/["'`】\]]+$/, "")
    .replace(/^[0-9]+[.)、:\-\s]+/, "")
    .trim();
  if (!stripped) {
    return undefined;
  }

  if (stripped.length <= maxChars) {
    return stripped;
  }
  return `${stripped.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function buildFallbackSessionTitle(prompt: string, maxChars = 28): string {
  const normalized = compactWhitespace(prompt);
  if (!normalized) {
    return "New Session";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}
