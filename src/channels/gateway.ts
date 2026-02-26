import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ChatOrchestrator } from "../core/orchestrator.js";
import { isTurnAbortedError } from "../core/abort.js";
import { buildFallbackSessionTitle } from "../core/session-title.js";
import type { SessionRecord } from "../core/session.js";
import type { AgentEvent, AgentId, ChatTurnResult } from "../core/types.js";
import { ChannelRegistry } from "./registry.js";
import {
  buildChannelConversationKey,
  buildChannelSessionId,
  decodeChannelSessionProjectKey,
  DEFAULT_CHANNEL_SESSION_PROJECT_KEY,
  normalizeChannelSessionProjectKey,
  parseChannelSessionId,
} from "./session-key.js";
import {
  buildTelegramProjectPickCallbackData,
  TELEGRAM_PROJECT_PICK_META_TOKEN,
} from "./telegram-project-picker.js";
import {
  buildTelegramDepthCallbackData,
  buildTelegramModelCallbackData,
  buildTelegramSandboxCallbackData,
} from "./telegram-preferences-picker.js";
import {
  buildTelegramRenamePickCallbackData,
  TELEGRAM_RENAME_PICK_META_TOKEN,
} from "./telegram-rename-picker.js";
import {
  buildTelegramSessionPickCallbackData,
  TELEGRAM_SESSION_PICK_META_SESSION_ID,
  TELEGRAM_SESSION_PICK_META_SESSION_NAME,
  TELEGRAM_SESSION_PICK_META_TOKEN,
} from "./telegram-session-picker.js";
import type { TurnDecisionAction } from "./turn-decision.js";
import {
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_BYPASS,
  TURN_DECISION_META_FORCE_STEER,
  TURN_DECISION_META_TOKEN,
  TURN_RUNNING_QUOTE_CALLBACK,
  TURN_RUNNING_STOP_CALLBACK,
  buildTurnDecisionCallbackData,
} from "./turn-decision.js";
import type {
  ChannelAdapter,
  ChannelAgentRouting,
  ChannelEditMessage,
  ChannelFileAttachment,
  ChannelId,
  ChannelInboundHandler,
  ChannelInboundMessage,
  ChannelOutboundMessage,
} from "./types.js";

const DEFAULT_PROGRESS_THROTTLE_MS = 1200;
const DEFAULT_DELTA_PREVIEW_MAX_CHARS = 180;
const TELEGRAM_SESSION_PICK_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_SESSION_PICK_MAX_ITEMS = 20;
const TELEGRAM_PROJECT_PICK_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_PROJECT_PICK_PAGE_SIZE = 8;
const TELEGRAM_RENAME_PICK_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_RENAME_PICK_MAX_ITEMS = 20;
const TELEGRAM_PENDING_INPUT_TTL_MS = 30 * 60 * 1000;
const RUNNING_ANIMATION_INTERVAL_MS = 500;
const SESSION_BRANCH_DELIMITER = "::";
const RUNNING_ANIMATION_FRAMES = [
  "🌑",
  "🌒",
  "🌓",
  "🌔",
  "🌕",
  "🌖",
  "🌗",
  "🌘",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function clipTextFromTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(Math.max(0, text.length - maxChars));
  }
  return `…${text.slice(text.length - (maxChars - 1))}`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function mergePickerSupplementalText(
  baseText: string,
  supplementalText: string | undefined,
): string {
  const baseLines = splitNonEmptyLines(baseText);
  if (!supplementalText?.trim()) {
    return baseLines.join("\n");
  }

  const merged = [...baseLines];
  const normalized = baseLines.map((line) => line.toLowerCase());
  for (const line of splitNonEmptyLines(supplementalText)) {
    const lineNormalized = line.toLowerCase();
    const duplicated = normalized.some(
      (existing) =>
        existing === lineNormalized ||
        existing.includes(lineNormalized) ||
        lineNormalized.includes(existing),
    );
    if (duplicated) {
      continue;
    }
    merged.push(line);
    normalized.push(lineNormalized);
  }
  return merged.join("\n");
}

function redactValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function logGatewayDebug(event: string, payload: Record<string, unknown>): void {
  const record = {
    ts: new Date().toISOString(),
    scope: "channel.gateway",
    event,
    ...payload,
  };
  try {
    console.log(JSON.stringify(record));
  } catch {
    // Logging must never change runtime behavior.
  }
}

function splitOutboundText(text: string, maxChars: number): string[] {
  const normalizedMax = Math.max(200, maxChars);
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = "";
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= normalizedMax) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (line.length <= normalizedMax) {
      current = line;
      continue;
    }

    let offset = 0;
    while (offset < line.length) {
      chunks.push(line.slice(offset, offset + normalizedMax));
      offset += normalizedMax;
    }
  }

  pushCurrent();
  return chunks;
}

function resolveCommandText(
  event: Extract<AgentEvent, { type: "command" }>,
): string | undefined {
  const payloadText = event.command.payload.text;
  if (typeof payloadText === "string") {
    return payloadText.trim();
  }
  return undefined;
}

function looksLikeSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return /^\/\S+/.test(trimmed);
}

function commandNameFromText(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const body = trimmed.slice(1).trim();
  if (!body) {
    return undefined;
  }
  const head = body.split(/\s+/)[0]?.trim().toLowerCase();
  if (!head) {
    return undefined;
  }
  const atIndex = head.indexOf("@");
  return atIndex > 0 ? head.slice(0, atIndex) : head;
}

function isSessionsCommandText(input: string): boolean {
  return commandNameFromText(input) === "sessions";
}

function isProjectCommandText(input: string): boolean {
  return commandNameFromText(input) === "project";
}

function isRenameCommandText(input: string): boolean {
  return commandNameFromText(input) === "rename";
}

function isRunningCommandText(input: string): boolean {
  return commandNameFromText(input) === "running";
}

function isSandboxCommandText(input: string): boolean {
  const name = commandNameFromText(input);
  return name === "sandbox" || name === "isolation";
}

function isModelCommandText(input: string): boolean {
  return commandNameFromText(input) === "model";
}

function isDepthCommandText(input: string): boolean {
  const name = commandNameFromText(input);
  return name === "depth" || name === "thinking";
}

type TelegramPickerCommand =
  | "sessions"
  | "project"
  | "rename"
  | "sandbox"
  | "model"
  | "depth";

function resolveTelegramPickerCommand(
  input: string,
): TelegramPickerCommand | undefined {
  if (isSessionsCommandText(input)) {
    return "sessions";
  }
  if (isProjectCommandText(input)) {
    return "project";
  }
  if (isRenameCommandText(input)) {
    return "rename";
  }
  if (isSandboxCommandText(input)) {
    return "sandbox";
  }
  if (isModelCommandText(input)) {
    return "model";
  }
  if (isDepthCommandText(input)) {
    return "depth";
  }
  return undefined;
}

function readTelegramProjectPickToken(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const token = metadata[TELEGRAM_PROJECT_PICK_META_TOKEN];
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }
  return token.trim();
}

function readTelegramRenamePickToken(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const token = metadata[TELEGRAM_RENAME_PICK_META_TOKEN];
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }
  return token.trim();
}

function readTelegramSessionPickToken(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const token = metadata[TELEGRAM_SESSION_PICK_META_TOKEN];
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }
  return token.trim();
}

function readTelegramSessionPickSessionId(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const sessionId = metadata[TELEGRAM_SESSION_PICK_META_SESSION_ID];
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return undefined;
  }
  return sessionId.trim();
}

function readTelegramSessionPickSessionName(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const name = metadata[TELEGRAM_SESSION_PICK_META_SESSION_NAME];
  if (typeof name !== "string" || !name.trim()) {
    return undefined;
  }
  return name.trim();
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

function clipSessionDisplayName(name: string, maxChars = 28): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "New Session";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function normalizeManualSessionName(value: string, maxChars = 80): string | undefined {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function normalizeProjectDirectoryName(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "." || normalized === "..") {
    return undefined;
  }
  if (/[/\\\u0000]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function resolveSessionProjectKey(sessionId: string): string {
  return parseChannelSessionId(sessionId)?.projectKey ?? DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
}

function matchesConversationSessionKey(candidate: string, conversationKey: string): boolean {
  return (
    candidate === conversationKey ||
    candidate.startsWith(`${conversationKey}${SESSION_BRANCH_DELIMITER}`)
  );
}

function cloneMetadata(metadata: unknown): Record<string, unknown> {
  if (!isRecord(metadata)) {
    return {};
  }
  return {
    ...metadata,
  };
}

function readTurnDecisionSelection(
  metadata: unknown,
): { action: TurnDecisionAction; token: string } | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const action = metadata[TURN_DECISION_META_ACTION];
  const token = metadata[TURN_DECISION_META_TOKEN];
  if (
    (action === "steer" || action === "stack") &&
    typeof token === "string" &&
    token.trim()
  ) {
    return {
      action,
      token: token.trim(),
    };
  }
  return null;
}

function shouldBypassTurnDecision(metadata: unknown): boolean {
  return isRecord(metadata) && metadata[TURN_DECISION_META_BYPASS] === true;
}

function shouldForceSteer(metadata: unknown): boolean {
  return (
    isRecord(metadata) && metadata[TURN_DECISION_META_FORCE_STEER] === true
  );
}

type TurnRelayOptions = {
  progressThrottleMs?: number;
  deltaPreviewMaxChars?: number;
};

type PendingTurnDecision = {
  token: string;
  inbound: ChannelInboundMessage;
  createdAt: number;
};

type StackedQueueEntry = {
  id: string;
  preview: string;
};

type PendingTelegramSessionPick = {
  token: string;
  sessionId: string;
  sessionName: string;
  channelId: ChannelId;
  chatId: string;
  threadId?: string;
  createdAt: number;
};

type PendingTelegramRenamePick = {
  token: string;
  sessionId: string;
  sessionName: string;
  channelId: ChannelId;
  chatId: string;
  threadId?: string;
  createdAt: number;
};

type ProjectOption = {
  key: string;
  name: string;
  lastUsedAt: number;
};

type PendingTelegramProjectPick = {
  token: string;
  channelId: ChannelId;
  chatId: string;
  threadId?: string;
  createdAt: number;
  action: "select" | "page" | "create";
  projectKey?: string;
  page?: number;
};

type PendingTelegramConversationInput =
  | {
      kind: "rename-session";
      createdAt: number;
      sessionId: string;
      previousName: string;
    }
  | {
      kind: "create-project";
      createdAt: number;
    };

class ChannelTurnRelay {
  private progressMessageId: string | undefined;
  private readonly seenStatus = new Set<string>();
  private deltaBuffer = "";
  private lastProgressAt = 0;
  private lastProgressText = "";
  private lastRenderedProgress = "";
  private animationFrameIndex = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private animationEditing = false;
  private progressChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly animationEnabled: boolean;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly inbound: ChannelInboundMessage,
    private readonly sessionId: string,
    private readonly options: TurnRelayOptions = {},
  ) {
    this.animationEnabled = !looksLikeSlashCommand(inbound.text);
  }

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "status":
        this.enqueueProgressWork(async () => {
          await this.handleStatus(event);
        });
        return;
      case "command":
        this.enqueueProgressWork(async () => {
          await this.handleCommand(event);
        });
        return;
      case "delta":
        this.enqueueProgressWork(async () => {
          await this.handleDelta(event.text);
        });
        return;
      case "error":
        this.enqueueProgressWork(async () => {
          await this.sendProgress(`任务执行出错：${event.error}`);
        });
        return;
      case "result":
        return;
      default:
        return;
    }
  }

  async finalize(result: ChatTurnResult): Promise<void> {
    this.closed = true;
    this.deltaBuffer = "";
    this.stopProgressAnimation(true);

    const maxChars = Math.max(300, this.adapter.capabilities.maxMessageChars);
    const fullText =
      typeof result.rawFinalText === "string"
        ? result.rawFinalText.replace(/\r/g, "").trim()
        : "";
    logGatewayDebug("relay.finalize.start", {
      channelId: this.adapter.id,
      chatId: redactValue(this.inbound.chatId),
      threadId: redactValue(this.inbound.threadId),
      messageId: redactValue(this.inbound.messageId),
      maxChars,
      finalTextChars: result.finalText.length,
      rawFinalTextChars: fullText.length,
      hasSendFile: Boolean(this.adapter.sendFile),
    });
    if (this.adapter.sendFile && fullText) {
      if (fullText.length <= maxChars) {
        await this.sendText(fullText, undefined, "final.full_text");
        return;
      }
      await this.sendText(clipTextFromTop(fullText, maxChars), undefined, "final.clipped");
      await this.sendFullTextAttachment(fullText);
      return;
    }

    const chunks = splitOutboundText(result.finalText, maxChars);
    if (chunks.length === 0) {
      await this.sendText("暂无可读结果，请重试。", undefined, "final.empty_fallback");
      return;
    }

    logGatewayDebug("relay.finalize.chunks", {
      channelId: this.adapter.id,
      chatId: redactValue(this.inbound.chatId),
      chunkCount: chunks.length,
      firstChunkChars: chunks[0]?.length ?? 0,
    });
    for (const chunk of chunks) {
      await this.sendText(chunk, undefined, "final.chunk");
    }
  }

  dispose(): void {
    this.closed = true;
    this.deltaBuffer = "";
    this.stopProgressAnimation(true);
  }

  belongsToSession(sessionId: string): boolean {
    return this.sessionId === sessionId;
  }

  getRunningProgressMessageId(): string | undefined {
    return this.progressMessageId;
  }

  private enqueueProgressWork(work: () => Promise<void>): void {
    if (this.closed) {
      return;
    }
    const run = async () => {
      if (this.closed) {
        return;
      }
      await work();
    };
    this.progressChain = this.progressChain.then(run, run).catch(() => {
      // Keep progress pipeline resilient on transport failures.
    });
  }

  private async sendFullTextAttachment(fullText: string): Promise<void> {
    if (!this.adapter.sendFile) {
      return;
    }
    const attachment: ChannelFileAttachment = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      fileName: `opencarapace-full-response-${Date.now()}.txt`,
      content: fullText,
      mimeType: "text/plain; charset=utf-8",
      caption: "完整版回复（文本附件）",
    };
    if (this.inbound.accountId) {
      attachment.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      attachment.threadId = this.inbound.threadId;
    }
    if (this.inbound.messageId) {
      attachment.replyToMessageId = this.inbound.messageId;
    }
    const startedAt = Date.now();
    logGatewayDebug("relay.send_attachment.attempt", {
      channelId: this.adapter.id,
      chatId: redactValue(this.inbound.chatId),
      threadId: redactValue(this.inbound.threadId),
      replyToMessageId: redactValue(this.inbound.messageId),
      fileName: attachment.fileName,
      contentChars: fullText.length,
    });
    try {
      const receipt = await this.adapter.sendFile(attachment);
      logGatewayDebug("relay.send_attachment.succeeded", {
        channelId: this.adapter.id,
        chatId: redactValue(this.inbound.chatId),
        messageId: redactValue(receipt.messageId),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logGatewayDebug("relay.send_attachment.failed", {
        channelId: this.adapter.id,
        chatId: redactValue(this.inbound.chatId),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handleStatus(
    event: Extract<AgentEvent, { type: "status" }>,
  ): Promise<void> {
    // Keep status notifications short and avoid repeatedly spamming the same phase.
    if (this.seenStatus.has(event.phase)) {
      return;
    }
    this.seenStatus.add(event.phase);
    if (event.phase === "completed") {
      return;
    }
    await this.sendProgress(event.message);
  }

  private async handleCommand(
    event: Extract<AgentEvent, { type: "command" }>,
  ): Promise<void> {
    if (event.command.name !== "progress" && event.command.name !== "notify") {
      return;
    }
    const text = resolveCommandText(event);
    if (!text) {
      return;
    }
    await this.sendProgress(text);
  }

  private async handleDelta(text: string): Promise<void> {
    const normalized = compactWhitespace(text);
    if (!normalized) {
      return;
    }
    this.deltaBuffer = compactWhitespace(`${this.deltaBuffer} ${normalized}`);
    await this.flushDeltaPreview(false);
  }

  private async flushDeltaPreview(force: boolean): Promise<void> {
    if (this.closed) {
      this.deltaBuffer = "";
      return;
    }
    if (!this.deltaBuffer) {
      return;
    }

    const throttleMs =
      this.options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < throttleMs) {
      return;
    }

    const maxChars =
      this.options.deltaPreviewMaxChars ?? DEFAULT_DELTA_PREVIEW_MAX_CHARS;
    const preview = clipText(this.deltaBuffer, maxChars);
    this.deltaBuffer = "";
    await this.sendProgress(`处理中：${preview}`);
  }

  private async sendProgress(text: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const normalized = clipText(compactWhitespace(text), 400);
    if (!normalized) {
      return;
    }
    this.lastProgressAt = Date.now();
    this.lastProgressText = normalized;
    const rendered = this.renderProgressText(normalized);

    if (
      this.animationEnabled &&
      this.adapter.capabilities.supportsMessageEdit &&
      this.progressMessageId &&
      this.adapter.editMessage
    ) {
      try {
        await this.editProgressMessage(rendered);
        if (this.closed) {
          return;
        }
        this.startProgressAnimation();
        return;
      } catch {
        // Degrade to sending a fresh progress message when edit fails.
        this.stopProgressAnimation();
        this.progressMessageId = undefined;
      }
    }

    const sent = await this.sendText(
      rendered,
      this.runningControlMetadata(),
      "progress.send",
    );
    if (this.closed) {
      return;
    }
    this.lastRenderedProgress = rendered;
    if (this.adapter.capabilities.supportsMessageEdit && sent.messageId) {
      this.progressMessageId = sent.messageId;
      this.startProgressAnimation();
    }
  }

  private renderProgressText(text: string): string {
    const frame =
      RUNNING_ANIMATION_FRAMES[
        this.animationFrameIndex % RUNNING_ANIMATION_FRAMES.length
      ] ?? "🌑";
    return `${frame} ${text}`;
  }

  private startProgressAnimation(): void {
    if (this.closed) {
      return;
    }
    if (!this.animationEnabled) {
      return;
    }
    if (
      !this.adapter.capabilities.supportsMessageEdit ||
      !this.adapter.editMessage ||
      !this.progressMessageId
    ) {
      return;
    }
    if (this.animationTimer) {
      return;
    }
    this.animationTimer = setInterval(() => {
      void this.tickProgressAnimation().catch(() => {
        // Keep gateway alive even if channel edit is rate-limited/transiently failing.
        this.stopProgressAnimation();
      });
    }, RUNNING_ANIMATION_INTERVAL_MS);
  }

  private stopProgressAnimation(resetState = false): void {
    if (!this.animationTimer) {
      if (resetState) {
        this.progressMessageId = undefined;
        this.lastProgressText = "";
        this.lastRenderedProgress = "";
      }
      return;
    }
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
    this.animationEditing = false;
    if (resetState) {
      this.progressMessageId = undefined;
      this.lastProgressText = "";
      this.lastRenderedProgress = "";
    }
  }

  private async tickProgressAnimation(): Promise<void> {
    if (this.closed) {
      this.stopProgressAnimation(true);
      return;
    }
    if (
      !this.lastProgressText ||
      !this.progressMessageId ||
      !this.adapter.editMessage
    ) {
      return;
    }
    if (this.adapter.isOutboundBusy?.(this.inbound.chatId)) {
      return;
    }
    if (this.animationEditing) {
      return;
    }
    this.animationEditing = true;
    try {
      this.animationFrameIndex =
        (this.animationFrameIndex + 1) % RUNNING_ANIMATION_FRAMES.length;
      await this.editProgressMessage(
        this.renderProgressText(this.lastProgressText),
      );
    } finally {
      this.animationEditing = false;
    }
  }

  private async editProgressMessage(text: string): Promise<void> {
    if (this.closed || !this.progressMessageId || !this.adapter.editMessage) {
      return;
    }
    if (text === this.lastRenderedProgress) {
      return;
    }
    const edit: ChannelEditMessage = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      messageId: this.progressMessageId,
      text,
    };
    if (this.inbound.accountId) {
      edit.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      edit.threadId = this.inbound.threadId;
    }
    const metadata = this.runningControlMetadata();
    if (metadata) {
      edit.metadata = metadata;
    }
    try {
      await this.adapter.editMessage(edit);
    } catch (error) {
      logGatewayDebug("relay.progress.edit_failed", {
        channelId: this.adapter.id,
        chatId: redactValue(this.inbound.chatId),
        threadId: redactValue(this.inbound.threadId),
        messageId: redactValue(this.progressMessageId),
        textChars: text.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.lastRenderedProgress = text;
  }

  private runningControlMetadata(): Record<string, unknown> | undefined {
    if (!this.animationEnabled) {
      return undefined;
    }
    if (this.adapter.id !== "telegram") {
      return undefined;
    }
    return {
      telegram_reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛑 Stop",
              callback_data: TURN_RUNNING_STOP_CALLBACK,
            },
            {
              text: "📌 Quote",
              callback_data: TURN_RUNNING_QUOTE_CALLBACK,
            },
          ],
        ],
      },
    };
  }

  private async sendText(
    text: string,
    metadata?: Record<string, unknown>,
    reason = "generic",
  ): Promise<{ messageId?: string }> {
    const outbound: ChannelOutboundMessage = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      text,
    };
    if (metadata) {
      outbound.metadata = metadata;
    }
    if (this.inbound.accountId) {
      outbound.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      outbound.threadId = this.inbound.threadId;
    }
    if (this.inbound.messageId) {
      outbound.replyToMessageId = this.inbound.messageId;
    }
    const startedAt = Date.now();
    logGatewayDebug("relay.send_text.attempt", {
      reason,
      channelId: this.adapter.id,
      chatId: redactValue(this.inbound.chatId),
      threadId: redactValue(this.inbound.threadId),
      replyToMessageId: redactValue(this.inbound.messageId),
      textChars: text.length,
      hasMetadata: Boolean(metadata),
    });
    try {
      const receipt = await this.adapter.sendMessage(outbound);
      logGatewayDebug("relay.send_text.succeeded", {
        reason,
        channelId: this.adapter.id,
        chatId: redactValue(this.inbound.chatId),
        messageId: redactValue(receipt.messageId),
        durationMs: Date.now() - startedAt,
      });
      return receipt;
    } catch (error) {
      logGatewayDebug("relay.send_text.failed", {
        reason,
        channelId: this.adapter.id,
        chatId: redactValue(this.inbound.chatId),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export type ChannelGatewayDeps = {
  orchestrator: ChatOrchestrator;
  registry?: ChannelRegistry;
  routing: ChannelAgentRouting;
  projectRootDir?: string;
};

export class ChannelGateway {
  readonly orchestrator: ChatOrchestrator;
  readonly registry: ChannelRegistry;
  readonly routing: ChannelAgentRouting;
  private readonly pendingTurnDecisions = new Map<
    string,
    PendingTurnDecision
  >();
  private readonly stackedTurnQueues = new Map<string, StackedQueueEntry[]>();
  private readonly pendingTelegramSessionPicks = new Map<
    string,
    PendingTelegramSessionPick
  >();
  private readonly pendingTelegramRenamePicks = new Map<
    string,
    PendingTelegramRenamePick
  >();
  private readonly pendingTelegramProjectPicks = new Map<
    string,
    PendingTelegramProjectPick
  >();
  private readonly pendingTelegramConversationInputs = new Map<
    string,
    PendingTelegramConversationInput
  >();
  private readonly activeProjectsByConversation = new Map<string, string>();
  private readonly activeSessionsByConversation = new Map<string, string>();
  private readonly activeRelays = new Set<ChannelTurnRelay>();
  private readonly activeSessionIds = new Set<string>();
  private stopping = false;
  private readonly projectRootDir: string | undefined;

  constructor(deps: ChannelGatewayDeps) {
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry ?? new ChannelRegistry();
    this.routing = deps.routing;
    this.projectRootDir = deps.projectRootDir?.trim()
      ? path.resolve(deps.projectRootDir.trim())
      : undefined;
  }

  registerChannel(adapter: ChannelAdapter): this {
    this.registry.register(adapter);
    return this;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const handler: ChannelInboundHandler = async (message) => {
      await this.handleInbound(message);
    };

    for (const channel of this.registry.list()) {
      if (channel.start) {
        await channel.start(handler);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const sessionId of this.activeSessionIds) {
      this.orchestrator.cancelRunningTurn(sessionId, "gateway stopping");
    }
    for (const relay of this.activeRelays) {
      relay.dispose();
    }
    for (const channel of this.registry.list()) {
      if (channel.stop) {
        await channel.stop();
      }
    }
  }

  async handleInbound(message: ChannelInboundMessage): Promise<ChatTurnResult> {
    const channel = this.registry.require(message.channelId);
    const conversationKey = buildChannelConversationKey(message);
    const activeProjectKey = this.resolveActiveProjectKey(conversationKey, message);
    const fallbackSessionId = buildChannelSessionId(message, {
      projectKey: activeProjectKey,
    });
    const defaultSessionId = this.resolveActiveSessionId(
      conversationKey,
      message,
      activeProjectKey,
    );
    const agentId = this.resolveAgentId(message.channelId);
    logGatewayDebug("gateway.inbound.received", {
      channelId: message.channelId,
      chatId: redactValue(message.chatId),
      threadId: redactValue(message.threadId),
      messageId: redactValue(message.messageId),
      replyToMessageId: redactValue(message.replyToMessageId),
      textChars: message.text.length,
      isCommand: looksLikeSlashCommand(message.text),
      defaultSessionId,
      fallbackSessionId,
      agentId,
    });
    const projectPickToken = readTelegramProjectPickToken(message.metadata);
    if (projectPickToken) {
      return await this.handleTelegramProjectPickSelection({
        channel,
        message,
        sessionId: defaultSessionId,
        agentId,
        conversationKey,
        token: projectPickToken,
      });
    }
    const renamePickToken = readTelegramRenamePickToken(message.metadata);
    if (renamePickToken) {
      return await this.handleTelegramRenamePickSelection({
        channel,
        message,
        sessionId: defaultSessionId,
        agentId,
        conversationKey,
        token: renamePickToken,
      });
    }
    const pickToken = readTelegramSessionPickToken(message.metadata);
    if (pickToken) {
      return await this.handleTelegramSessionPickSelection({
        channel,
        message,
        sessionId: defaultSessionId,
        agentId,
        token: pickToken,
      });
    }

    const sessionId = readTelegramSessionPickSessionId(message.metadata) ?? defaultSessionId;
    if (this.stopping) {
      logGatewayDebug("gateway.inbound.ignored_stopping", {
        channelId: message.channelId,
        chatId: redactValue(message.chatId),
        sessionId,
      });
      return this.emptyTurnResult(agentId, sessionId);
    }
    const sessionProjectKey = resolveSessionProjectKey(sessionId);
    this.activeProjectsByConversation.set(conversationKey, sessionProjectKey);
    this.activeSessionsByConversation.set(conversationKey, sessionId);
    const selectedSessionName = readTelegramSessionPickSessionName(message.metadata);
    const turnDecision = readTurnDecisionSelection(message.metadata);
    if (turnDecision) {
      return await this.handleTurnDecisionSelection({
        channel,
        message,
        sessionId,
        agentId,
        selection: turnDecision,
      });
    }
    if (channel.id === "telegram") {
      const pendingInputResult = await this.handleTelegramPendingConversationInput({
        channel,
        message,
        conversationKey,
        sessionId,
        agentId,
      });
      if (pendingInputResult) {
        return pendingInputResult;
      }
    }

    if (
      this.pendingTurnDecisions.has(sessionId) &&
      !this.orchestrator.isTurnRunning(sessionId)
    ) {
      this.pendingTurnDecisions.delete(sessionId);
    }

    const bypassTurnDecision = shouldBypassTurnDecision(message.metadata);
    const isCommandMessage = looksLikeSlashCommand(message.text);
    if (channel.id === "telegram" && isRunningCommandText(message.text)) {
      const runningProgressMessageId = this.findRunningProgressMessageId(sessionId);
      if (runningProgressMessageId) {
        await this.sendAuxiliaryMessage(
          channel,
          message,
          "已定位当前 running 消息。",
          runningProgressMessageId,
        );
        return this.emptyTurnResult(agentId, sessionId);
      }
    }
    if (
      !isCommandMessage &&
      this.orchestrator.isTurnRunning(sessionId) &&
      !bypassTurnDecision
    ) {
      await this.promptTurnDecision(channel, message, sessionId);
      return this.emptyTurnResult(agentId, sessionId);
    }

    const relay = new ChannelTurnRelay(channel, message, sessionId);
    this.activeRelays.add(relay);
    this.activeSessionIds.add(sessionId);
    const steerTriggered =
      !isCommandMessage &&
      shouldForceSteer(message.metadata) &&
      this.orchestrator.cancelRunningTurn(
        sessionId,
        `Steered by newer message ${message.messageId ?? "(no-message-id)"}`,
      );

    try {
      const normalizedMetadata = cloneMetadata(message.metadata);
      delete normalizedMetadata[TURN_DECISION_META_ACTION];
      delete normalizedMetadata[TURN_DECISION_META_TOKEN];
      delete normalizedMetadata[TURN_DECISION_META_BYPASS];
      delete normalizedMetadata[TURN_DECISION_META_FORCE_STEER];
      delete normalizedMetadata[TELEGRAM_SESSION_PICK_META_TOKEN];
      delete normalizedMetadata[TELEGRAM_SESSION_PICK_META_SESSION_ID];
      delete normalizedMetadata[TELEGRAM_SESSION_PICK_META_SESSION_NAME];
      delete normalizedMetadata[TELEGRAM_PROJECT_PICK_META_TOKEN];
      delete normalizedMetadata[TELEGRAM_RENAME_PICK_META_TOKEN];

      const result = await this.orchestrator.chat({
        agentId,
        sessionId,
        input: message.text,
        metadata: {
          channelId: message.channelId,
          accountId: message.accountId,
          chatId: message.chatId,
          senderId: message.senderId,
          senderName: message.senderName,
          threadId: message.threadId,
          messageId: message.messageId,
          replyToMessageId: message.replyToMessageId,
          attachmentPaths: message.attachmentPaths,
          imagePaths: message.imagePaths,
          rawInbound: message.raw,
          steer: steerTriggered,
          project_key: sessionProjectKey,
          project_name: decodeChannelSessionProjectKey(sessionProjectKey),
          project_root_dir: this.projectRootDir ?? "",
          ...normalizedMetadata,
        },
        onEvent: async (event) => {
          await relay.onEvent(event);
        },
      });

      const decorated = selectedSessionName
        ? this.decorateSelectedSessionHistory(
            result,
            sessionId,
            selectedSessionName,
          )
        : result;
      const effectiveSessionId = decorated.sessionId || sessionId;
      if (effectiveSessionId !== sessionId) {
        this.activeSessionsByConversation.set(conversationKey, effectiveSessionId);
        this.activeProjectsByConversation.set(
          conversationKey,
          resolveSessionProjectKey(effectiveSessionId),
        );
      }
      logGatewayDebug("gateway.turn.completed", {
        channelId: message.channelId,
        chatId: redactValue(message.chatId),
        sessionId: effectiveSessionId,
        agentId,
        finalTextChars: decorated.finalText.length,
      });
      const telegramPickerCommand =
        channel.id === "telegram"
          ? resolveTelegramPickerCommand(message.text)
          : undefined;
      if (telegramPickerCommand) {
        relay.dispose();
      } else {
        await relay.finalize(decorated);
      }
      if (telegramPickerCommand === "sessions") {
        await this.sendTelegramSessionPicker(channel, message, sessionProjectKey);
      } else if (telegramPickerCommand === "project") {
        await this.sendTelegramProjectPicker(
          channel,
          message,
          sessionProjectKey,
          0,
          decorated.finalText,
        );
      } else if (telegramPickerCommand === "rename") {
        await this.sendTelegramRenamePicker(
          channel,
          message,
          sessionProjectKey,
          decorated.finalText,
        );
      } else if (telegramPickerCommand === "sandbox") {
        await this.sendTelegramSandboxPicker(
          channel,
          message,
          effectiveSessionId,
          decorated.finalText,
        );
      } else if (telegramPickerCommand === "model") {
        await this.sendTelegramModelPicker(
          channel,
          message,
          effectiveSessionId,
          decorated.finalText,
        );
      } else if (telegramPickerCommand === "depth") {
        await this.sendTelegramDepthPicker(
          channel,
          message,
          effectiveSessionId,
          decorated.finalText,
        );
      }
      return decorated;
    } catch (error) {
      if (isTurnAbortedError(error)) {
        logGatewayDebug("gateway.turn.aborted", {
          channelId: message.channelId,
          chatId: redactValue(message.chatId),
          sessionId,
          agentId,
        });
        return this.emptyTurnResult(agentId, sessionId);
      }

      const reason = error instanceof Error ? error.message : String(error);
      logGatewayDebug("gateway.turn.failed", {
        channelId: message.channelId,
        chatId: redactValue(message.chatId),
        sessionId,
        agentId,
        error: reason,
      });
      const failure: ChannelOutboundMessage = {
        channelId: channel.id,
        chatId: message.chatId,
        text: `任务执行失败：${reason}`,
      };
      if (message.accountId) {
        failure.accountId = message.accountId;
      }
      if (message.threadId) {
        failure.threadId = message.threadId;
      }
      if (message.messageId) {
        failure.replyToMessageId = message.messageId;
      }
      await channel.sendMessage(failure);
      throw error;
    } finally {
      relay.dispose();
      this.activeRelays.delete(relay);
      this.activeSessionIds.delete(sessionId);
    }
  }

  private async handleTurnDecisionSelection(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    selection: {
      action: TurnDecisionAction;
      token: string;
    };
  }): Promise<ChatTurnResult> {
    const pending = this.pendingTurnDecisions.get(params.sessionId);
    if (!pending) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "当前没有待决策的新消息，请直接发送新消息。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    if (pending.token !== params.selection.token) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个选项已过期，请按最新提示选择。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTurnDecisions.delete(params.sessionId);
    const forceSteer = params.selection.action === "steer";
    const replayMetadata = cloneMetadata(pending.inbound.metadata);
    replayMetadata[TURN_DECISION_META_BYPASS] = true;
    replayMetadata[TURN_DECISION_META_FORCE_STEER] = forceSteer;
    const replay: ChannelInboundMessage = {
      ...pending.inbound,
      metadata: replayMetadata,
    };
    if (forceSteer) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "已选择 1. steer：正在中断当前任务并切换到新消息。",
      );
      return await this.handleInbound(replay);
    }

    const queued = this.enqueueStackedTurn(params.sessionId, pending.inbound.text);
    try {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        this.formatStackQueueMessage(queued.snapshot),
      );
      return await this.handleInbound(replay);
    } finally {
      this.dequeueStackedTurn(params.sessionId, queued.entryId);
    }
  }

  private async handleTelegramSessionPickSelection(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    token: string;
  }): Promise<ChatTurnResult> {
    this.pruneTelegramSessionPickEntries();
    const pending = this.pendingTelegramSessionPicks.get(params.token);
    if (!pending) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个会话选项已过期，请重新执行 /sessions。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }
    const sameThread =
      (pending.threadId ?? "").trim() === (params.message.threadId ?? "").trim();
    if (
      pending.channelId !== params.message.channelId ||
      pending.chatId !== params.message.chatId ||
      !sameThread
    ) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个会话选项不属于当前对话，请重新执行 /sessions。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTelegramSessionPicks.delete(params.token);
    const replayMetadata = cloneMetadata(params.message.metadata);
    delete replayMetadata[TELEGRAM_SESSION_PICK_META_TOKEN];
    replayMetadata[TELEGRAM_SESSION_PICK_META_SESSION_ID] = pending.sessionId;
    replayMetadata[TELEGRAM_SESSION_PICK_META_SESSION_NAME] = pending.sessionName;
    const replay: ChannelInboundMessage = {
      ...params.message,
      text: "/history 20",
      metadata: replayMetadata,
    };
    return await this.handleInbound(replay);
  }

  private async handleTelegramRenamePickSelection(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    conversationKey: string;
    token: string;
  }): Promise<ChatTurnResult> {
    this.pruneTelegramRenamePickEntries();
    const pending = this.pendingTelegramRenamePicks.get(params.token);
    if (!pending) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个重命名选项已过期，请重新执行 /rename。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }
    const sameThread =
      (pending.threadId ?? "").trim() === (params.message.threadId ?? "").trim();
    if (
      pending.channelId !== params.message.channelId ||
      pending.chatId !== params.message.chatId ||
      !sameThread
    ) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个重命名选项不属于当前对话，请重新执行 /rename。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTelegramRenamePicks.delete(params.token);
    this.pendingTelegramConversationInputs.set(params.conversationKey, {
      kind: "rename-session",
      createdAt: Date.now(),
      sessionId: pending.sessionId,
      previousName: pending.sessionName,
    });
    await this.sendAuxiliaryMessage(
      params.channel,
      params.message,
      [
        `已选择会话：${clipSessionDisplayName(pending.sessionName, 48)}`,
        "请直接发送新的 session 名称。",
        "发送 /cancel 可取消。",
      ].join("\n"),
    );
    return this.emptyTurnResult(params.agentId, params.sessionId);
  }

  private async handleTelegramPendingConversationInput(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    conversationKey: string;
    sessionId: string;
    agentId: AgentId;
  }): Promise<ChatTurnResult | null> {
    this.pruneTelegramConversationInputEntries();
    const pending = this.pendingTelegramConversationInputs.get(params.conversationKey);
    if (!pending) {
      return null;
    }

    if (looksLikeSlashCommand(params.message.text)) {
      if (commandNameFromText(params.message.text) === "cancel") {
        this.pendingTelegramConversationInputs.delete(params.conversationKey);
        await this.sendAuxiliaryMessage(
          params.channel,
          params.message,
          "已取消当前输入操作。",
        );
        return this.emptyTurnResult(params.agentId, params.sessionId);
      }
      return null;
    }

    const rawInput = params.message.text.trim();
    if (!rawInput) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        pending.kind === "rename-session"
          ? "名称不能为空，请重新发送新的 session 名称。"
          : "project 名称不能为空，请重新发送。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    if (pending.kind === "rename-session") {
      return await this.applyTelegramSessionRename({
        channel: params.channel,
        message: params.message,
        sessionId: params.sessionId,
        agentId: params.agentId,
        conversationKey: params.conversationKey,
        pending,
        requestedName: rawInput,
      });
    }
    return await this.applyTelegramProjectCreation({
      channel: params.channel,
      message: params.message,
      sessionId: params.sessionId,
      agentId: params.agentId,
      conversationKey: params.conversationKey,
      requestedName: rawInput,
    });
  }

  private async applyTelegramSessionRename(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    conversationKey: string;
    pending: Extract<PendingTelegramConversationInput, { kind: "rename-session" }>;
    requestedName: string;
  }): Promise<ChatTurnResult> {
    const normalizedName = normalizeManualSessionName(params.requestedName);
    if (!normalizedName) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "名称无效，请重新发送新的 session 名称。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    const targetSession = this.orchestrator.sessions.snapshot(params.pending.sessionId);
    if (!targetSession) {
      this.pendingTelegramConversationInputs.delete(params.conversationKey);
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "目标 session 不存在，请重新执行 /rename。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.orchestrator.sessions.setMetadata(targetSession.id, targetSession.agentId, {
      session_name: normalizedName,
      session_name_source: "manual",
    });
    this.pendingTelegramConversationInputs.delete(params.conversationKey);
    await this.sendAuxiliaryMessage(
      params.channel,
      params.message,
      [
        "session 已重命名。",
        `- from: ${clipSessionDisplayName(params.pending.previousName, 48)}`,
        `- to: ${clipSessionDisplayName(normalizedName, 48)}`,
      ].join("\n"),
    );
    return this.emptyTurnResult(params.agentId, params.sessionId);
  }

  private async applyTelegramProjectCreation(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    conversationKey: string;
    requestedName: string;
  }): Promise<ChatTurnResult> {
    if (!this.projectRootDir) {
      this.pendingTelegramConversationInputs.delete(params.conversationKey);
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "未配置 project root，请先执行 `opencarapace config tui` 设置 runtime.project_root_dir。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    const projectName = normalizeProjectDirectoryName(params.requestedName);
    if (!projectName) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "project 名称无效，不能包含 / 或 \\，且不能是 . 或 ..。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    const nextPath = path.resolve(this.projectRootDir, projectName);
    const rootPrefix = `${path.resolve(this.projectRootDir)}${path.sep}`;
    if (nextPath !== path.resolve(this.projectRootDir) && !nextPath.startsWith(rootPrefix)) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "project 名称无效，请更换名称后重试。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    if (fs.existsSync(nextPath)) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        `project 已存在：${projectName}，请换一个名称。`,
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    try {
      fs.mkdirSync(nextPath, { recursive: false });
    } catch (error) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        `新建 project 失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTelegramConversationInputs.delete(params.conversationKey);
    const nextProjectKey = normalizeChannelSessionProjectKey(projectName);
    this.activeProjectsByConversation.set(params.conversationKey, nextProjectKey);
    this.activeSessionsByConversation.delete(params.conversationKey);
    await this.sendAuxiliaryMessage(
      params.channel,
      params.message,
      `已新建并切换 project：${projectName}\n后续新对话将绑定到该 project。`,
    );
    return this.emptyTurnResult(params.agentId, params.sessionId);
  }

  private async handleTelegramProjectPickSelection(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    conversationKey: string;
    token: string;
  }): Promise<ChatTurnResult> {
    this.pruneTelegramProjectPickEntries();
    const pending = this.pendingTelegramProjectPicks.get(params.token);
    if (!pending) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个项目选项已过期，请重新执行 /project。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }
    const sameThread =
      (pending.threadId ?? "").trim() === (params.message.threadId ?? "").trim();
    if (
      pending.channelId !== params.message.channelId ||
      pending.chatId !== params.message.chatId ||
      !sameThread
    ) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个项目选项不属于当前对话，请重新执行 /project。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTelegramProjectPicks.delete(params.token);
    if (pending.action === "page") {
      const activeProjectKey = this.resolveActiveProjectKey(
        params.conversationKey,
        params.message,
      );
      await this.sendTelegramProjectPicker(
        params.channel,
        params.message,
        activeProjectKey,
        pending.page ?? 0,
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }
    if (pending.action === "create") {
      this.pendingTelegramConversationInputs.set(params.conversationKey, {
        kind: "create-project",
        createdAt: Date.now(),
      });
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        [
          "请直接发送新 project 名称。",
          "发送 /cancel 可取消。",
        ].join("\n"),
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    const nextProjectKey = pending.projectKey?.trim();
    if (!nextProjectKey) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "项目选择无效，请重新执行 /project。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }
    this.pendingTelegramConversationInputs.delete(params.conversationKey);
    this.activeProjectsByConversation.set(params.conversationKey, nextProjectKey);
    this.activeSessionsByConversation.delete(params.conversationKey);
    const projectName = decodeChannelSessionProjectKey(nextProjectKey);
    await this.sendAuxiliaryMessage(
      params.channel,
      params.message,
      `已切换 project：${projectName}\n后续新对话将绑定到该 project。`,
    );
    return this.emptyTurnResult(params.agentId, params.sessionId);
  }

  private async promptTurnDecision(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    sessionId: string,
  ): Promise<void> {
    const token = randomUUID();
    this.pendingTurnDecisions.set(sessionId, {
      token,
      inbound,
      createdAt: Date.now(),
    });

    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: [
        "<b>检测到你发送了新消息</b>",
        "当前任务仍在运行，请选择处理方式：",
        "1. <b>steer</b>：中断当前任务并切换到新消息",
        "2. <b>stack</b>：保持当前任务，新消息进入队列",
      ].join("\n"),
      metadata: {
        telegram_parse_mode: "HTML",
        telegram_reply_markup: {
          inline_keyboard: [
            [
              {
                text: "1. Steer",
                callback_data: buildTurnDecisionCallbackData(token, "steer"),
              },
              {
                text: "2. Stack",
                callback_data: buildTurnDecisionCallbackData(token, "stack"),
              },
            ],
          ],
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendAuxiliaryMessage(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text,
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    const replyTo = replyToMessageId?.trim() || inbound.messageId;
    if (replyTo) {
      outbound.replyToMessageId = replyTo;
    }
    await channel.sendMessage(outbound);
  }

  private findRunningProgressMessageId(sessionId: string): string | undefined {
    for (const relay of this.activeRelays) {
      if (!relay.belongsToSession(sessionId)) {
        continue;
      }
      const messageId = relay.getRunningProgressMessageId();
      if (messageId) {
        return messageId;
      }
    }
    return undefined;
  }

  private decorateSelectedSessionHistory(
    result: ChatTurnResult,
    sessionId: string,
    sessionName: string,
  ): ChatTurnResult {
    const heading = `Session: ${sessionName}\nID: ${sessionId}`;
    const body = result.finalText.trim();
    const finalText = body ? `${heading}\n\n${body}` : heading;
    return {
      ...result,
      finalText,
      rawFinalText: finalText,
    };
  }

  private async sendTelegramSessionPicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    projectKey: string,
  ): Promise<void> {
    const sessions = this.listSessionsByProject(projectKey).slice(
      0,
      TELEGRAM_SESSION_PICK_MAX_ITEMS,
    );
    if (sessions.length === 0) {
      return;
    }
    this.pruneTelegramSessionPickEntries();

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const [index, session] of sessions.entries()) {
      const token = randomUUID();
      const sessionName = resolveSessionDisplayName(session);
      const pending = {
        token,
        sessionId: session.id,
        sessionName,
        channelId: inbound.channelId,
        chatId: inbound.chatId,
        createdAt: Date.now(),
      } as PendingTelegramSessionPick;
      if (inbound.threadId !== undefined) {
        pending.threadId = inbound.threadId;
      }
      this.pendingTelegramSessionPicks.set(token, pending);
      const callbackData = buildTelegramSessionPickCallbackData(token);
      if (!callbackData) {
        continue;
      }
      rows.push([
        {
          text: `${index + 1}. ${clipSessionDisplayName(sessionName)}`,
          callback_data: callbackData,
        },
      ]);
    }

    if (rows.length === 0) {
      return;
    }

    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: [
        `当前 project：${decodeChannelSessionProjectKey(projectKey)}`,
        "点击会话可查看该会话名称和最近 20 条 history：",
      ].join("\n"),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: rows,
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendTelegramRenamePicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    projectKey: string,
    supplementalText?: string,
  ): Promise<void> {
    const sessions = this.listSessionsByProject(projectKey).slice(
      0,
      TELEGRAM_RENAME_PICK_MAX_ITEMS,
    );
    if (sessions.length === 0) {
      await this.sendAuxiliaryMessage(
        channel,
        inbound,
        "当前 project 暂无可重命名会话，请先发送消息创建会话。",
      );
      return;
    }
    this.pruneTelegramRenamePickEntries();

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const [index, session] of sessions.entries()) {
      const token = randomUUID();
      const sessionName = resolveSessionDisplayName(session);
      const pending = {
        token,
        sessionId: session.id,
        sessionName,
        channelId: inbound.channelId,
        chatId: inbound.chatId,
        createdAt: Date.now(),
      } as PendingTelegramRenamePick;
      if (inbound.threadId !== undefined) {
        pending.threadId = inbound.threadId;
      }
      this.pendingTelegramRenamePicks.set(token, pending);
      const callbackData = buildTelegramRenamePickCallbackData(token);
      if (!callbackData) {
        continue;
      }
      rows.push([
        {
          text: `${index + 1}. ${clipSessionDisplayName(sessionName)}`,
          callback_data: callbackData,
        },
      ]);
    }

    if (rows.length === 0) {
      return;
    }

    const baseText = [
      `当前 project：${decodeChannelSessionProjectKey(projectKey)}`,
      "点击会话后发送新名称：",
    ].join("\n");
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: mergePickerSupplementalText(baseText, supplementalText),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: rows,
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendTelegramSandboxPicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    sessionId: string,
    supplementalText?: string,
  ): Promise<void> {
    const metadata = this.orchestrator.sessions.getMetadata(sessionId);
    const rawMode =
      typeof metadata.sandbox_mode === "string" ? metadata.sandbox_mode.trim() : "";
    const currentMode = rawMode || "(default)";
    const isCurrent = (
      mode: "read-only" | "workspace-write" | "danger-full-access" | "clear",
    ): boolean => {
      if (mode === "clear") {
        return !rawMode;
      }
      return rawMode === mode;
    };

    const baseText = [
      "Sandbox mode (workspace)",
      `- current: ${currentMode}`,
      "点击按钮直接切换：",
    ].join("\n");
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: mergePickerSupplementalText(baseText, supplementalText),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${isCurrent("read-only") ? "✅ " : ""}read-only`,
                callback_data: buildTelegramSandboxCallbackData("read-only"),
              },
              {
                text: `${isCurrent("workspace-write") ? "✅ " : ""}workspace-write`,
                callback_data: buildTelegramSandboxCallbackData("workspace-write"),
              },
            ],
            [
              {
                text: `${isCurrent("danger-full-access") ? "✅ " : ""}danger-full-access`,
                callback_data: buildTelegramSandboxCallbackData("danger-full-access"),
              },
            ],
            [
              {
                text: `${isCurrent("clear") ? "✅ " : ""}clear(default)`,
                callback_data: buildTelegramSandboxCallbackData("clear"),
              },
            ],
          ],
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendTelegramModelPicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    sessionId: string,
    supplementalText?: string,
  ): Promise<void> {
    const metadata = this.orchestrator.sessions.getMetadata(sessionId);
    const rawModel =
      typeof metadata.model === "string" ? metadata.model.trim() : "";
    const currentModel = rawModel || "(default)";
    const isCurrent = (model: "gpt-5" | "gpt-5.1" | "clear"): boolean => {
      if (model === "clear") {
        return !rawModel;
      }
      return rawModel === model;
    };

    const baseText = [
      "Model preference (global)",
      `- current: ${currentModel}`,
      "点击按钮设置模型：",
    ].join("\n");
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: mergePickerSupplementalText(baseText, supplementalText),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${isCurrent("gpt-5") ? "✅ " : ""}gpt-5`,
                callback_data: buildTelegramModelCallbackData("gpt-5"),
              },
              {
                text: `${isCurrent("gpt-5.1") ? "✅ " : ""}gpt-5.1`,
                callback_data: buildTelegramModelCallbackData("gpt-5.1"),
              },
            ],
            [
              {
                text: `${isCurrent("clear") ? "✅ " : ""}clear(default)`,
                callback_data: buildTelegramModelCallbackData("clear"),
              },
              {
                text: "custom...",
                callback_data: buildTelegramModelCallbackData("custom"),
              },
            ],
          ],
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendTelegramDepthPicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    sessionId: string,
    supplementalText?: string,
  ): Promise<void> {
    const metadata = this.orchestrator.sessions.getMetadata(sessionId);
    const rawDepth =
      typeof metadata.thinking_depth === "string"
        ? metadata.thinking_depth.trim()
        : "";
    const currentDepth = rawDepth || "(default)";
    const isCurrent = (depth: "low" | "medium" | "high" | "clear"): boolean => {
      if (depth === "clear") {
        return !rawDepth;
      }
      return rawDepth === depth;
    };

    const baseText = [
      "Thinking depth preference (global)",
      `- current: ${currentDepth}`,
      "点击按钮设置深度：",
    ].join("\n");
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: mergePickerSupplementalText(baseText, supplementalText),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${isCurrent("low") ? "✅ " : ""}low`,
                callback_data: buildTelegramDepthCallbackData("low"),
              },
              {
                text: `${isCurrent("medium") ? "✅ " : ""}medium`,
                callback_data: buildTelegramDepthCallbackData("medium"),
              },
              {
                text: `${isCurrent("high") ? "✅ " : ""}high`,
                callback_data: buildTelegramDepthCallbackData("high"),
              },
            ],
            [
              {
                text: `${isCurrent("clear") ? "✅ " : ""}clear(default)`,
                callback_data: buildTelegramDepthCallbackData("clear"),
              },
            ],
          ],
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendTelegramProjectPicker(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    currentProjectKey: string,
    page: number,
    supplementalText?: string,
  ): Promise<void> {
    if (!this.projectRootDir) {
      await this.sendAuxiliaryMessage(
        channel,
        inbound,
        "未配置 project root，请先执行 `opencarapace config tui` 设置 runtime.project_root_dir。",
      );
      return;
    }
    const projects = this.listProjectsFromRoot();
    this.pruneTelegramProjectPickEntries();

    const totalPages = Math.max(1, Math.ceil(projects.length / TELEGRAM_PROJECT_PICK_PAGE_SIZE));
    const safePage =
      projects.length === 0
        ? 0
        : Math.min(totalPages - 1, Math.max(0, Math.floor(page)));
    const start = safePage * TELEGRAM_PROJECT_PICK_PAGE_SIZE;
    const items =
      projects.length === 0
        ? []
        : projects.slice(start, start + TELEGRAM_PROJECT_PICK_PAGE_SIZE);
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const project of items) {
      const token = randomUUID();
      const pending = {
        token,
        action: "select",
        projectKey: project.key,
        channelId: inbound.channelId,
        chatId: inbound.chatId,
        createdAt: Date.now(),
      } as PendingTelegramProjectPick;
      if (inbound.threadId !== undefined) {
        pending.threadId = inbound.threadId;
      }
      this.pendingTelegramProjectPicks.set(token, pending);
      const callbackData = buildTelegramProjectPickCallbackData(token);
      if (!callbackData) {
        continue;
      }
      const marker = project.key === currentProjectKey ? "✅ " : "";
      rows.push([
        {
          text: `${marker}${project.name}`,
          callback_data: callbackData,
        },
      ]);
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (projects.length > 0 && safePage > 0) {
      const token = randomUUID();
      const pending = {
        token,
        action: "page",
        page: safePage - 1,
        channelId: inbound.channelId,
        chatId: inbound.chatId,
        createdAt: Date.now(),
      } as PendingTelegramProjectPick;
      if (inbound.threadId !== undefined) {
        pending.threadId = inbound.threadId;
      }
      this.pendingTelegramProjectPicks.set(token, pending);
      const callbackData = buildTelegramProjectPickCallbackData(token);
      if (callbackData) {
        navRow.push({
          text: "◀ 上一页",
          callback_data: callbackData,
        });
      }
    }
    if (projects.length > 0 && safePage + 1 < totalPages) {
      const token = randomUUID();
      const pending = {
        token,
        action: "page",
        page: safePage + 1,
        channelId: inbound.channelId,
        chatId: inbound.chatId,
        createdAt: Date.now(),
      } as PendingTelegramProjectPick;
      if (inbound.threadId !== undefined) {
        pending.threadId = inbound.threadId;
      }
      this.pendingTelegramProjectPicks.set(token, pending);
      const callbackData = buildTelegramProjectPickCallbackData(token);
      if (callbackData) {
        navRow.push({
          text: safePage === 0 ? "更多 ▶" : "下一页 ▶",
          callback_data: callbackData,
        });
      }
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    const createToken = randomUUID();
    const createPending = {
      token: createToken,
      action: "create",
      channelId: inbound.channelId,
      chatId: inbound.chatId,
      createdAt: Date.now(),
    } as PendingTelegramProjectPick;
    if (inbound.threadId !== undefined) {
      createPending.threadId = inbound.threadId;
    }
    this.pendingTelegramProjectPicks.set(createToken, createPending);
    const createCallback = buildTelegramProjectPickCallbackData(createToken);
    if (createCallback) {
      rows.push([
        {
          text: "➕ 新建 project",
          callback_data: createCallback,
        },
      ]);
    }

    if (rows.length === 0) {
      return;
    }

    const end = Math.min(projects.length, start + items.length);
    const projectsLine =
      projects.length > 0
        ? `Projects ${start + 1}-${end}/${projects.length}（Top ${TELEGRAM_PROJECT_PICK_PAGE_SIZE}）`
        : `Projects 0/0（Top ${TELEGRAM_PROJECT_PICK_PAGE_SIZE}）`;
    const actionLine =
      projects.length > 0
        ? "点击项目可切换，列表按最近使用时间排序；底部按钮可新建项目。"
        : "当前还没有可选项目，点击底部按钮新建。";
    const baseText = [
      `Project root：${this.projectRootDir}`,
      `当前 project：${decodeChannelSessionProjectKey(currentProjectKey)}`,
      projectsLine,
      actionLine,
    ].join("\n");
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: mergePickerSupplementalText(baseText, supplementalText),
      metadata: {
        telegram_reply_markup: {
          inline_keyboard: rows,
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private pruneTelegramSessionPickEntries(): void {
    const now = Date.now();
    for (const [token, entry] of this.pendingTelegramSessionPicks.entries()) {
      if (now - entry.createdAt > TELEGRAM_SESSION_PICK_TTL_MS) {
        this.pendingTelegramSessionPicks.delete(token);
      }
    }
  }

  private pruneTelegramRenamePickEntries(): void {
    const now = Date.now();
    for (const [token, entry] of this.pendingTelegramRenamePicks.entries()) {
      if (now - entry.createdAt > TELEGRAM_RENAME_PICK_TTL_MS) {
        this.pendingTelegramRenamePicks.delete(token);
      }
    }
  }

  private pruneTelegramConversationInputEntries(): void {
    const now = Date.now();
    for (const [conversationKey, entry] of this.pendingTelegramConversationInputs.entries()) {
      if (now - entry.createdAt > TELEGRAM_PENDING_INPUT_TTL_MS) {
        this.pendingTelegramConversationInputs.delete(conversationKey);
      }
    }
  }

  private pruneTelegramProjectPickEntries(): void {
    const now = Date.now();
    for (const [token, entry] of this.pendingTelegramProjectPicks.entries()) {
      if (now - entry.createdAt > TELEGRAM_PROJECT_PICK_TTL_MS) {
        this.pendingTelegramProjectPicks.delete(token);
      }
    }
  }

  private resolveActiveProjectKey(
    conversationKey: string,
    message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
  ): string {
    const active = this.activeProjectsByConversation.get(conversationKey);
    if (active) {
      return active;
    }
    const inferred = this.inferLatestProjectForConversation(conversationKey, message);
    const resolved = inferred ?? DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
    this.activeProjectsByConversation.set(conversationKey, resolved);
    return resolved;
  }

  private resolveActiveSessionId(
    conversationKey: string,
    message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
    projectKey: string,
  ): string {
    const active = this.activeSessionsByConversation.get(conversationKey);
    if (active && resolveSessionProjectKey(active) === projectKey) {
      return active;
    }
    const inferred = this.inferLatestSessionForConversation(
      conversationKey,
      projectKey,
      message,
    );
    const resolved =
      inferred ??
      buildChannelSessionId(message, {
        projectKey,
      });
    this.activeSessionsByConversation.set(conversationKey, resolved);
    return resolved;
  }

  private inferLatestProjectForConversation(
    conversationKey: string,
    message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
  ): string | undefined {
    const fallbackSessionId = buildChannelSessionId(message);
    const fallbackProject = resolveSessionProjectKey(fallbackSessionId);
    for (const session of this.orchestrator.sessions.list()) {
      const parsed = parseChannelSessionId(session.id);
      if (parsed && matchesConversationSessionKey(parsed.conversationKey, conversationKey)) {
        return parsed.projectKey;
      }
      if (!parsed && session.id === fallbackSessionId) {
        return fallbackProject;
      }
    }
    return undefined;
  }

  private inferLatestSessionForConversation(
    conversationKey: string,
    projectKey: string,
    message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
  ): string | undefined {
    const fallbackSessionId = buildChannelSessionId(message, {
      projectKey,
    });
    for (const session of this.orchestrator.sessions.list()) {
      const parsed = parseChannelSessionId(session.id);
      if (
        parsed &&
        parsed.projectKey === projectKey &&
        matchesConversationSessionKey(parsed.conversationKey, conversationKey)
      ) {
        return session.id;
      }
      if (!parsed && session.id === fallbackSessionId) {
        return session.id;
      }
    }
    return undefined;
  }

  private listSessionsByProject(projectKey: string): SessionRecord[] {
    return this.orchestrator.sessions
      .list()
      .filter((session) => resolveSessionProjectKey(session.id) === projectKey);
  }

  private listProjectsFromRoot(): ProjectOption[] {
    const root = this.projectRootDir;
    if (!root) {
      return [];
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const lastUsedByKey = new Map<string, number>();
    for (const session of this.orchestrator.sessions.list()) {
      const key = resolveSessionProjectKey(session.id);
      const previous = lastUsedByKey.get(key) ?? 0;
      if (session.updatedAt > previous) {
        lastUsedByKey.set(key, session.updatedAt);
      }
    }
    const projects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const key = normalizeChannelSessionProjectKey(entry.name);
        return {
          key,
          name: entry.name,
          lastUsedAt: lastUsedByKey.get(key) ?? 0,
        } satisfies ProjectOption;
      });
    projects.sort(
      (left, right) =>
        right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    );
    return projects;
  }

  private enqueueStackedTurn(
    sessionId: string,
    text: string,
  ): { entryId: string; snapshot: string[] } {
    const queue = this.stackedTurnQueues.get(sessionId) ?? [];
    const entry: StackedQueueEntry = {
      id: randomUUID(),
      preview: clipText(compactWhitespace(text), 80),
    };
    queue.push(entry);
    this.stackedTurnQueues.set(sessionId, queue);
    return {
      entryId: entry.id,
      snapshot: queue.map((item) => item.preview),
    };
  }

  private dequeueStackedTurn(sessionId: string, entryId: string): void {
    const queue = this.stackedTurnQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }
    const next = queue.filter((item) => item.id !== entryId);
    if (next.length === 0) {
      this.stackedTurnQueues.delete(sessionId);
      return;
    }
    this.stackedTurnQueues.set(sessionId, next);
  }

  private formatStackQueueMessage(queuePreviews: string[]): string {
    const rows = queuePreviews.map((item, index) => `${index + 1}. ${item}`);
    return [
      "已选择 2. stack：新消息已进入队列。",
      "当前队列（按顺序）：",
      ...rows,
    ].join("\n");
  }

  private emptyTurnResult(agentId: AgentId, sessionId: string): ChatTurnResult {
    return {
      agentId,
      sessionId,
      finalText: "",
      rawFinalText: "",
      events: [],
    };
  }

  private resolveAgentId(channelId: ChannelId): AgentId {
    return this.routing.perChannel?.[channelId] ?? this.routing.defaultAgentId;
  }
}
