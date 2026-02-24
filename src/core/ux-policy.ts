const SENTENCE_SPLIT_RE = /(?<=[。！？.!?])\s+/g;

export type ReadabilityPolicyOptions = {
  maxChars?: number;
  maxLines?: number;
};

export class ReadabilityPolicy {
  constructor(private readonly options: ReadabilityPolicyOptions = {}) {}

  normalize(text: string): string {
    const maxChars = this.options.maxChars ?? 900;
    const maxLines = this.options.maxLines ?? 14;

    const trimmed = text.replace(/\r/g, "").trim();
    if (!trimmed) {
      return "暂无可读结果，请重试。";
    }

    const normalizedSpaces = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");

    const structured = this.ensureLineStructure(normalizedSpaces);
    const clippedChars =
      structured.length > maxChars ? `${structured.slice(0, Math.max(0, maxChars - 1))}…` : structured;

    const lines = clippedChars
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxLines);

    return lines.join("\n");
  }

  private ensureLineStructure(text: string): string {
    if (text.includes("\n")) {
      return text;
    }
    const sentences = text
      .split(SENTENCE_SPLIT_RE)
      .map((item) => item.trim())
      .filter(Boolean);
    if (sentences.length <= 1) {
      return text;
    }
    return sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n");
  }
}
