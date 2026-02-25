import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TELEGRAM_PROJECT_PICK_META_TOKEN,
  parseTelegramProjectPickCallbackData,
} from "./telegram-project-picker.js";
import {
  TELEGRAM_SESSION_PICK_META_TOKEN,
  parseTelegramSessionPickCallbackData,
} from "./telegram-session-picker.js";
import {
  isTurnRunningQuoteCallbackData,
  isTurnRunningStopCallbackData,
  parseTurnDecisionCallbackData,
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_TOKEN,
} from "./turn-decision.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEditMessage,
  ChannelFileAttachment,
  ChannelInboundHandler,
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelSendReceipt,
} from "./types.js";

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number | string;
  };
};

type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
};

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
};

type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

type TelegramMediaFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
};

type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
};

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramMediaFile;
  audio?: TelegramMediaFile;
  document?: TelegramMediaFile;
  video?: TelegramMediaFile;
  video_note?: TelegramMediaFile;
  animation?: TelegramMediaFile;
  sticker?: TelegramMediaFile;
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: {
    message_id: number;
  };
};

type TelegramAttachmentKind =
  | "photo"
  | "voice"
  | "audio"
  | "document"
  | "video"
  | "video_note"
  | "animation"
  | "sticker";

type TelegramAttachmentCandidate = {
  kind: TelegramAttachmentKind;
  fileId: string;
  defaultExt: string;
  isImage: boolean;
};

type DownloadedTelegramAttachments = {
  attachmentPaths: string[];
  imagePaths: string[];
  kinds: TelegramAttachmentKind[];
  errors: string[];
};

type TelegramOutboundScopeState = {
  chain: Promise<void>;
  lastOutboundAt: number;
  rateLimitedUntilAt: number;
  pendingCount: number;
};

type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramGetUpdatesResponse = TelegramApiEnvelope<TelegramUpdate[]>;

export type TelegramChannelAdapterOptions = {
  token: string;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  allowedChatIds?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TELEGRAM_OUTBOUND_MIN_INTERVAL_MS = 1200;
const TELEGRAM_OUTBOUND_SCOPE_IDLE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_RATE_LIMIT_FALLBACK_RETRY_SECONDS = 1;
const TELEGRAM_RATE_LIMIT_MAX_ATTEMPTS = 5;
const TELEGRAM_RATE_LIMIT_JITTER_MIN = 0.5;
const TELEGRAM_RATE_LIMIT_JITTER_MAX = 1.5;

class TelegramRateLimitError extends Error {
  readonly method: string;
  readonly retryAfterSeconds: number;
  readonly status: number | undefined;

  constructor(params: {
    method: string;
    retryAfterSeconds: number;
    status?: number;
    description?: string;
  }) {
    const suffix = params.description ? `: ${params.description}` : "";
    super(
      `telegram api rate limited (${params.method}): retry_after=${params.retryAfterSeconds}${suffix}`,
    );
    this.name = "TelegramRateLimitError";
    this.method = params.method;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.status = params.status;
  }
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

function parseRetryAfterFromErrorEnvelope(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parameters = value.parameters;
  if (!isRecord(parameters)) {
    return undefined;
  }
  const retryAfter = parameters.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.max(0, Math.floor(retryAfter));
  }
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return undefined;
}

function parseRetryAfterFromHeader(value: string | null): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsedSeconds = Number(normalized);
  if (Number.isFinite(parsedSeconds)) {
    return Math.max(0, Math.floor(parsedSeconds));
  }
  const parsedDateMs = Date.parse(normalized);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(0, Math.ceil((parsedDateMs - Date.now()) / 1000));
  }
  return undefined;
}

function parseErrorCodeFromErrorEnvelope(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const code = value.error_code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return Math.floor(code);
  }
  if (typeof code === "string" && code.trim()) {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseDescriptionFromErrorEnvelope(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const description = value.description;
  if (typeof description === "string" && description.trim()) {
    return description.trim();
  }
  return undefined;
}

function parseTelegramHttpErrorBody(
  bodyText: string,
): {
  errorCode?: number;
  description?: string;
  retryAfterSeconds?: number;
  bodyPreview?: string;
} {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const errorCode = parseErrorCodeFromErrorEnvelope(parsed);
    const description = parseDescriptionFromErrorEnvelope(parsed);
    const retryAfterSeconds = parseRetryAfterFromErrorEnvelope(parsed);
    const output: {
      errorCode?: number;
      description?: string;
      retryAfterSeconds?: number;
      bodyPreview?: string;
    } = {};
    if (errorCode !== undefined) {
      output.errorCode = errorCode;
    }
    if (description !== undefined) {
      output.description = description;
    }
    if (retryAfterSeconds !== undefined) {
      output.retryAfterSeconds = retryAfterSeconds;
    }
    return output;
  } catch {
    return {
      bodyPreview: trimmed.slice(0, 300),
    };
  }
}

function logTelegramDebug(
  event: string,
  payload: Record<string, unknown>,
): void {
  const record = {
    ts: new Date().toISOString(),
    scope: "telegram.adapter",
    event,
    ...payload,
  };
  try {
    console.log(JSON.stringify(record));
  } catch {
    // Logging must never change runtime behavior.
  }
}

function resolveRetryAfterSeconds(candidate: number | undefined): number {
  if (candidate === undefined || !Number.isFinite(candidate) || candidate < 0) {
    return TELEGRAM_RATE_LIMIT_FALLBACK_RETRY_SECONDS;
  }
  return Math.max(1, Math.floor(candidate));
}

function resolveRetryJitterFactor(): number {
  const range = TELEGRAM_RATE_LIMIT_JITTER_MAX - TELEGRAM_RATE_LIMIT_JITTER_MIN;
  return TELEGRAM_RATE_LIMIT_JITTER_MIN + Math.random() * range;
}

function isTelegramRateLimitError(error: unknown): error is TelegramRateLimitError {
  return error instanceof TelegramRateLimitError;
}

function isRateLimitedErrorShape(params: {
  status: number | undefined;
  errorCode: number | undefined;
  retryAfterSeconds: number | undefined;
}): boolean {
  return (
    params.status === 429 ||
    params.errorCode === 429 ||
    params.retryAfterSeconds !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizeOptionalString(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function resolveTelegramParseMode(metadata: unknown): "MarkdownV2" | "HTML" | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const raw = metadata.telegram_parse_mode;
  if (raw === "MarkdownV2" || raw === "HTML") {
    return raw;
  }
  return undefined;
}

function resolveTelegramReplyMarkup(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const value = metadata.telegram_reply_markup;
  if (!isRecord(value)) {
    return undefined;
  }
  return value;
}

function resolveInboundText(message: TelegramMessage): string {
  const text = message.text?.trim();
  if (text) {
    return text;
  }

  const caption = message.caption?.trim();
  if (caption) {
    return caption;
  }

  if (isVoiceOnlyInput(message)) {
    return "这是用户的语音输入，请直接理解语音内容并执行用户诉求，不要要求用户先转写。";
  }

  if (hasAttachment(message)) {
    return "请基于附带附件进行处理。";
  }

  return "";
}

function isVoiceOnlyInput(message: TelegramMessage): boolean {
  if (message.text?.trim() || message.caption?.trim()) {
    return false;
  }
  return Boolean(
    message.voice &&
      !message.photo?.length &&
      !message.audio &&
      !message.document &&
      !message.video &&
      !message.video_note &&
      !message.animation &&
      !message.sticker,
  );
}

function pickLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  if (photos.length === 0) {
    return undefined;
  }

  let best: TelegramPhotoSize | undefined = undefined;
  let bestScore = -1;
  for (const photo of photos) {
    const score = photo.file_size ?? photo.width * photo.height;
    if (score > bestScore) {
      best = photo;
      bestScore = score;
    }
  }
  return best;
}

function pushAttachmentCandidate(
  output: TelegramAttachmentCandidate[],
  seen: Set<string>,
  params: {
    kind: TelegramAttachmentKind;
    fileId: string | undefined;
    defaultExt: string;
    isImage: boolean;
  },
): void {
  const fileId = params.fileId?.trim();
  if (!fileId || seen.has(fileId)) {
    return;
  }
  seen.add(fileId);
  output.push({
    kind: params.kind,
    fileId,
    defaultExt: params.defaultExt,
    isImage: params.isImage,
  });
}

function resolveAttachmentCandidates(message: TelegramMessage): TelegramAttachmentCandidate[] {
  const candidates: TelegramAttachmentCandidate[] = [];
  const seen = new Set<string>();

  const photo = message.photo?.length ? pickLargestPhoto(message.photo) : undefined;
  if (photo) {
    pushAttachmentCandidate(candidates, seen, {
      kind: "photo",
      fileId: photo.file_id,
      defaultExt: ".jpg",
      isImage: true,
    });
  }

  pushAttachmentCandidate(candidates, seen, {
    kind: "voice",
    fileId: message.voice?.file_id,
    defaultExt: ".ogg",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "audio",
    fileId: message.audio?.file_id,
    defaultExt: ".mp3",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "document",
    fileId: message.document?.file_id,
    defaultExt: ".bin",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "video",
    fileId: message.video?.file_id,
    defaultExt: ".mp4",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "video_note",
    fileId: message.video_note?.file_id,
    defaultExt: ".mp4",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "animation",
    fileId: message.animation?.file_id,
    defaultExt: ".mp4",
    isImage: false,
  });
  pushAttachmentCandidate(candidates, seen, {
    kind: "sticker",
    fileId: message.sticker?.file_id,
    defaultExt: ".webp",
    isImage: true,
  });

  return candidates;
}

function hasAttachment(message: TelegramMessage): boolean {
  return resolveAttachmentCandidates(message).length > 0;
}

function normalizeExtensionCandidate(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^\.[a-z0-9]{1,9}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

const TELEGRAM_COMMANDS: TelegramBotCommand[] = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show current session status" },
  { command: "stop", description: "Interrupt current running turn in this session" },
  { command: "new", description: "Keep current session and switch to a new one" },
  { command: "history", description: "Show recent messages in this session" },
  { command: "session", description: "Show current session metadata" },
  { command: "sessions", description: "List recent sessions" },
  { command: "running", description: "Quote current session to locate running turn" },
  { command: "project", description: "Select active project" },
  { command: "agent", description: "Show or switch current agent" },
  { command: "model", description: "Show or set model preference" },
  { command: "depth", description: "Show or set thinking depth" },
  { command: "sandbox", description: "Set codex sandbox mode for this session" },
  { command: "memory", description: "Show or clear memory entries" },
  { command: "tools", description: "List available tools" },
  { command: "grep", description: "Search workspace text by keyword" },
  { command: "skill", description: "Search or show OpenClaw skills" },
  { command: "command", description: "Show command hub help" },
  { command: "commands", description: "Alias of help" },
];

function buildDefaultReplyKeyboardMarkup(): Record<string, unknown> {
  return {
    keyboard: [[{ text: "/new" }, { text: "/sessions" }], [{ text: "/running" }, { text: "/project" }]],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram" as const;
  readonly displayName = "Telegram";
  readonly capabilities: ChannelCapabilities = {
    supportsMessageEdit: true,
    maxMessageChars: 4000,
    supportsThreads: true,
  };

  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly retryDelayMs: number;
  private readonly allowedChatIds: Set<string> | null;

  private running = false;
  private offset = 0;
  private runner: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private readonly outboundScopes = new Map<string, TelegramOutboundScopeState>();
  private outboundSequence = 0;
  private sendMessageSequence = 0;

  constructor(options: TelegramChannelAdapterOptions) {
    this.token = options.token.trim();
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.pollTimeoutSeconds = Math.max(1, options.pollTimeoutSeconds ?? 25);
    this.retryDelayMs = Math.max(200, options.retryDelayMs ?? 1200);
    const allow = (options.allowedChatIds ?? []).map((entry) => entry.trim()).filter(Boolean);
    this.allowedChatIds = allow.length > 0 ? new Set(allow) : null;
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    if (this.running) {
      logTelegramDebug("adapter.start.skipped_already_running", {});
      return;
    }
    logTelegramDebug("adapter.start.begin", {
      pollTimeoutSeconds: this.pollTimeoutSeconds,
      retryDelayMs: this.retryDelayMs,
      allowedChatCount: this.allowedChatIds?.size ?? 0,
    });

    try {
      await this.registerBotCommands();
    } catch (error) {
      logTelegramDebug("adapter.start.register_commands_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Best-effort: message polling should continue even if command registration fails.
    }

    this.running = true;
    this.abort = new AbortController();
    this.runner = this.runPollLoop(handler, this.abort.signal);
    logTelegramDebug("adapter.start.completed", {
      hasAbortController: Boolean(this.abort),
    });
  }

  async stop(): Promise<void> {
    logTelegramDebug("adapter.stop.begin", {
      wasRunning: this.running,
    });
    this.running = false;
    if (this.abort) {
      this.abort.abort();
    }
    const active = this.runner;
    this.abort = null;
    this.runner = null;
    if (active) {
      try {
        await active;
      } catch (error) {
        logTelegramDebug("adapter.stop.runner_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logTelegramDebug("adapter.stop.completed", {});
  }

  isOutboundBusy(chatId?: string): boolean {
    const now = Date.now();
    const normalizedScopeKey = chatId?.trim();
    if (normalizedScopeKey) {
      const scope = this.outboundScopes.get(normalizedScopeKey);
      if (!scope) {
        return false;
      }
      return scope.pendingCount > 0 || now < scope.rateLimitedUntilAt;
    }
    for (const scope of this.outboundScopes.values()) {
      if (scope.pendingCount > 0 || now < scope.rateLimitedUntilAt) {
        return true;
      }
    }
    return false;
  }

  private getOutboundScopeState(scopeKey: string): TelegramOutboundScopeState {
    let state = this.outboundScopes.get(scopeKey);
    if (!state) {
      state = {
        chain: Promise.resolve(),
        lastOutboundAt: 0,
        rateLimitedUntilAt: 0,
        pendingCount: 0,
      };
      this.outboundScopes.set(scopeKey, state);
    }
    return state;
  }

  private pruneOutboundScopes(now = Date.now()): void {
    for (const [scopeKey, state] of this.outboundScopes.entries()) {
      if (state.pendingCount > 0) {
        continue;
      }
      const keepUntil = Math.max(
        state.lastOutboundAt + TELEGRAM_OUTBOUND_MIN_INTERVAL_MS,
        state.rateLimitedUntilAt,
      );
      if (now >= keepUntil + TELEGRAM_OUTBOUND_SCOPE_IDLE_TTL_MS) {
        this.outboundScopes.delete(scopeKey);
      }
    }
  }

  private async reserveOutboundSlot(
    operation: string,
    scopeKey: string,
    outboundSequence: number,
    state: TelegramOutboundScopeState,
  ): Promise<{ waitMs: number; reservedAtMs: number }> {
    const now = Date.now();
    const minIntervalUntil = state.lastOutboundAt + TELEGRAM_OUTBOUND_MIN_INTERVAL_MS;
    const blockedUntil = Math.max(minIntervalUntil, state.rateLimitedUntilAt);
    const waitMs = Math.max(0, blockedUntil - now);
    logTelegramDebug("outbound.slot.wait", {
      operation,
      scopeKey: redactValue(scopeKey),
      outboundSequence,
      now,
      minIntervalUntil,
      rateLimitedUntilAt: state.rateLimitedUntilAt,
      waitMs,
      minIntervalMs: TELEGRAM_OUTBOUND_MIN_INTERVAL_MS,
    });
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const reservedAtMs = Date.now();
    state.lastOutboundAt = reservedAtMs;
    logTelegramDebug("outbound.slot.reserved", {
      operation,
      scopeKey: redactValue(scopeKey),
      outboundSequence,
      reservedAtMs,
    });
    return {
      waitMs,
      reservedAtMs,
    };
  }

  private async queueOutboundRequest<T>(
    operation: string,
    scopeKey: string,
    work: (context: { outboundSequence: number; reservedAtMs: number; attempt: number }) => Promise<T>,
  ): Promise<T> {
    this.pruneOutboundScopes();
    const outboundSequence = ++this.outboundSequence;
    const normalizedScopeKey = scopeKey.trim() || "__unknown_chat__";
    const scopeState = this.getOutboundScopeState(normalizedScopeKey);
    const run = async () => {
      let attempt = 0;
      while (true) {
        const slot = await this.reserveOutboundSlot(
          operation,
          normalizedScopeKey,
          outboundSequence,
          scopeState,
        );
        attempt += 1;
        try {
          const result = await work({
            outboundSequence,
            reservedAtMs: slot.reservedAtMs,
            attempt,
          });
          return result;
        } catch (error) {
          if (!isTelegramRateLimitError(error)) {
            throw error;
          }
          const telegramRetryAfterSeconds = resolveRetryAfterSeconds(error.retryAfterSeconds);
          if (attempt >= TELEGRAM_RATE_LIMIT_MAX_ATTEMPTS) {
            logTelegramDebug("outbound.rate_limited_exhausted", {
              operation,
              scopeKey: redactValue(normalizedScopeKey),
              outboundSequence,
              attempt,
              method: error.method,
              status: error.status,
              telegramRetryAfterSeconds,
              maxAttempts: TELEGRAM_RATE_LIMIT_MAX_ATTEMPTS,
            });
            throw new Error(
              `telegram api rate limit retries exhausted (${operation}): attempts=${attempt}`,
            );
          }
          const jitterFactor = resolveRetryJitterFactor();
          const retryWaitMs = Math.max(
            0,
            Math.ceil(telegramRetryAfterSeconds * jitterFactor * 1000),
          );
          const retryUntil = Date.now() + retryWaitMs;
          scopeState.rateLimitedUntilAt = Math.max(scopeState.rateLimitedUntilAt, retryUntil);
          const effectiveRetryWaitMs = Math.max(0, scopeState.rateLimitedUntilAt - Date.now());
          const effectiveRetrySeconds = Math.max(1, Math.ceil(effectiveRetryWaitMs / 1000));
          logTelegramDebug("outbound.rate_limited_retry", {
            operation,
            scopeKey: redactValue(normalizedScopeKey),
            outboundSequence,
            attempt,
            method: error.method,
            status: error.status,
            policy: "retry_after_jitter",
            telegramRetryAfterSeconds,
            jitterFactor,
            retryAfterSeconds: effectiveRetrySeconds,
            retryWaitMs: effectiveRetryWaitMs,
            rateLimitedUntilAt: scopeState.rateLimitedUntilAt,
          });
        }
      }
    };
    scopeState.pendingCount += 1;
    const next = scopeState.chain.then(run, run);
    const tracked = next.finally(() => {
      scopeState.pendingCount = Math.max(0, scopeState.pendingCount - 1);
      this.pruneOutboundScopes();
    });
    scopeState.chain = tracked.then(() => undefined, () => undefined);
    return await tracked;
  }

  async sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt> {
    const sequence = ++this.sendMessageSequence;
    logTelegramDebug("sendMessage.attempt", {
      sequence,
      chatId: redactValue(message.chatId),
      threadId: redactValue(message.threadId),
      replyToMessageId: redactValue(message.replyToMessageId),
      textChars: message.text.length,
      hasMetadata: Boolean(message.metadata),
    });
    return await this.queueOutboundRequest("sendMessage", message.chatId, async ({ reservedAtMs, attempt }) => {
      const payload: Record<string, unknown> = {
        chat_id: message.chatId,
        text: message.text,
        disable_web_page_preview: true,
      };
      const parseMode = resolveTelegramParseMode(message.metadata);
      if (parseMode) {
        payload.parse_mode = parseMode;
      }
      const replyMarkup = resolveTelegramReplyMarkup(message.metadata);
      payload.reply_markup = replyMarkup ?? buildDefaultReplyKeyboardMarkup();

      const replyTo = normalizeOptionalInt(message.replyToMessageId);
      if (replyTo !== undefined) {
        payload.reply_to_message_id = replyTo;
      }

      const threadId = normalizeOptionalInt(message.threadId);
      if (threadId !== undefined) {
        payload.message_thread_id = threadId;
      }

      const startedAt = Date.now();
      let response: TelegramMessage;
      try {
        response = await this.callApi<TelegramMessage>("sendMessage", payload);
      } catch (error) {
        logTelegramDebug("sendMessage.failed", {
          sequence,
          attempt,
          elapsedSinceSlotMs: Date.now() - reservedAtMs,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logTelegramDebug("sendMessage.succeeded", {
        sequence,
        attempt,
        elapsedSinceSlotMs: Date.now() - reservedAtMs,
        durationMs: Date.now() - startedAt,
        messageId: redactValue(normalizeOptionalString(response.message_id)),
      });
      const receipt: ChannelSendReceipt = {
        raw: response,
      };
      const messageId = normalizeOptionalString(response.message_id);
      if (messageId) {
        receipt.messageId = messageId;
      }
      return receipt;
    });
  }

  async editMessage(message: ChannelEditMessage): Promise<ChannelSendReceipt> {
    return await this.queueOutboundRequest("editMessage", message.chatId, async ({ reservedAtMs, attempt }) => {
      const payload: Record<string, unknown> = {
        chat_id: message.chatId,
        message_id: Number(message.messageId),
        text: message.text,
        disable_web_page_preview: true,
      };
      const parseMode = resolveTelegramParseMode(message.metadata);
      if (parseMode) {
        payload.parse_mode = parseMode;
      }
      const replyMarkup = resolveTelegramReplyMarkup(message.metadata);
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      const threadId = normalizeOptionalInt(message.threadId);
      if (threadId !== undefined) {
        payload.message_thread_id = threadId;
      }

      const startedAt = Date.now();
      let response: TelegramMessage | undefined;
      try {
        response = await this.callApi<TelegramMessage>("editMessageText", payload);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (/message is not modified/i.test(reason)) {
          logTelegramDebug("editMessage.ignored_not_modified", {
            chatId: redactValue(message.chatId),
            messageId: redactValue(message.messageId),
            attempt,
            elapsedSinceSlotMs: Date.now() - reservedAtMs,
            durationMs: Date.now() - startedAt,
          });
          return {};
        }
        logTelegramDebug("editMessage.failed", {
          chatId: redactValue(message.chatId),
          messageId: redactValue(message.messageId),
          attempt,
          elapsedSinceSlotMs: Date.now() - reservedAtMs,
          durationMs: Date.now() - startedAt,
          error: reason,
        });
        throw error;
      }
      logTelegramDebug("editMessage.succeeded", {
        chatId: redactValue(message.chatId),
        messageId: redactValue(normalizeOptionalString(response.message_id) ?? message.messageId),
        attempt,
        elapsedSinceSlotMs: Date.now() - reservedAtMs,
        durationMs: Date.now() - startedAt,
        textChars: message.text.length,
      });
      const receipt: ChannelSendReceipt = {
        raw: response,
      };
      const messageId = normalizeOptionalString(response.message_id);
      if (messageId) {
        receipt.messageId = messageId;
      }
      return receipt;
    });
  }

  async sendFile(attachment: ChannelFileAttachment): Promise<ChannelSendReceipt> {
    logTelegramDebug("sendFile.attempt", {
      chatId: redactValue(attachment.chatId),
      threadId: redactValue(attachment.threadId),
      replyToMessageId: redactValue(attachment.replyToMessageId),
      fileName: attachment.fileName || "opencarapace-attachment.txt",
      mimeType: attachment.mimeType ?? "text/plain; charset=utf-8",
      captionChars: attachment.caption?.length ?? 0,
    });
    return await this.queueOutboundRequest("sendFile", attachment.chatId, async ({ reservedAtMs, attempt }) => {
      const payload = new FormData();
      payload.set("chat_id", attachment.chatId);

      const replyTo = normalizeOptionalInt(attachment.replyToMessageId);
      if (replyTo !== undefined) {
        payload.set("reply_to_message_id", String(replyTo));
      }

      const threadId = normalizeOptionalInt(attachment.threadId);
      if (threadId !== undefined) {
        payload.set("message_thread_id", String(threadId));
      }

      const caption = attachment.caption?.trim();
      if (caption) {
        payload.set(
          "caption",
          caption.length > 1024 ? `${caption.slice(0, 1023)}…` : caption,
        );
      }

      const mimeType = attachment.mimeType?.trim() || "text/plain; charset=utf-8";
      const contentPart: BlobPart =
        typeof attachment.content === "string"
          ? attachment.content
          : new Uint8Array(attachment.content);
      const blob = new Blob([contentPart], { type: mimeType });
      payload.set("document", blob, attachment.fileName || "opencarapace-attachment.txt");

      const startedAt = Date.now();
      let response: TelegramMessage;
      try {
        response = await this.callMultipartApi<TelegramMessage>("sendDocument", payload);
      } catch (error) {
        logTelegramDebug("sendFile.failed", {
          chatId: redactValue(attachment.chatId),
          attempt,
          elapsedSinceSlotMs: Date.now() - reservedAtMs,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logTelegramDebug("sendFile.succeeded", {
        chatId: redactValue(attachment.chatId),
        attempt,
        elapsedSinceSlotMs: Date.now() - reservedAtMs,
        messageId: redactValue(normalizeOptionalString(response.message_id)),
        durationMs: Date.now() - startedAt,
      });
      const receipt: ChannelSendReceipt = {
        raw: response,
      };
      const messageId = normalizeOptionalString(response.message_id);
      if (messageId) {
        receipt.messageId = messageId;
      }
      return receipt;
    });
  }

  private async handleCallbackQuery(
    callbackQuery: TelegramCallbackQuery,
    handler: ChannelInboundHandler,
  ): Promise<void> {
    const callbackId = callbackQuery.id?.trim();
    const rawData = callbackQuery.data?.trim();
    const message = callbackQuery.message;
    if (!callbackId || !rawData || !message) {
      logTelegramDebug("callback_query.ignored_invalid_payload", {
        hasCallbackId: Boolean(callbackId),
        hasRawData: Boolean(rawData),
        hasMessage: Boolean(message),
      });
      return;
    }
    logTelegramDebug("callback_query.received", {
      callbackId: redactValue(callbackId),
      hasData: Boolean(rawData),
      chatId: redactValue(normalizeOptionalString(message.chat?.id)),
      messageId: redactValue(normalizeOptionalString(message.message_id)),
    });

    const decision = parseTurnDecisionCallbackData(rawData);
    const stopRequested = isTurnRunningStopCallbackData(rawData);
    const runningQuoteRequested = isTurnRunningQuoteCallbackData(rawData);
    const sessionPick = parseTelegramSessionPickCallbackData(rawData);
    const projectPick = parseTelegramProjectPickCallbackData(rawData);
    if (
      !decision &&
      !stopRequested &&
      !runningQuoteRequested &&
      !sessionPick &&
      !projectPick
    ) {
      logTelegramDebug("callback_query.ignored_unrecognized_data", {
        callbackId: redactValue(callbackId),
      });
      this.acknowledgeCallbackQuery(callbackId);
      return;
    }

    const chatId = String(message.chat.id);
    if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
      logTelegramDebug("callback_query.ignored_chat_not_allowed", {
        callbackId: redactValue(callbackId),
        chatId: redactValue(chatId),
      });
      this.acknowledgeCallbackQuery(callbackId);
      return;
    }

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      chatId,
      text: stopRequested
        ? "/stop"
        : runningQuoteRequested
          ? "/running"
        : sessionPick
          ? "/session-pick"
          : projectPick
            ? "/project-pick"
            : "/turn-decision",
      raw: callbackQuery,
    };
    if (decision) {
      inbound.metadata = {
        [TURN_DECISION_META_ACTION]: decision.action,
        [TURN_DECISION_META_TOKEN]: decision.token,
      };
    }
    if (sessionPick) {
      inbound.metadata = {
        ...(inbound.metadata ?? {}),
        [TELEGRAM_SESSION_PICK_META_TOKEN]: sessionPick.token,
      };
    }
    if (projectPick) {
      inbound.metadata = {
        ...(inbound.metadata ?? {}),
        [TELEGRAM_PROJECT_PICK_META_TOKEN]: projectPick.token,
      };
    }

    const senderId = normalizeOptionalString(callbackQuery.from?.id);
    if (senderId) {
      inbound.senderId = senderId;
    }
    const senderName = callbackQuery.from?.username || callbackQuery.from?.first_name;
    if (senderName) {
      inbound.senderName = senderName;
    }
    const messageId = normalizeOptionalString(message.message_id);
    if (messageId) {
      inbound.messageId = messageId;
    }
    const threadId = normalizeOptionalString(message.message_thread_id);
    if (threadId) {
      inbound.threadId = threadId;
    }
    const replyToMessageId = normalizeOptionalString(message.reply_to_message?.message_id);
    if (replyToMessageId) {
      inbound.replyToMessageId = replyToMessageId;
    }

    this.acknowledgeCallbackQuery(
      callbackId,
      stopRequested
        ? "已请求 stop"
        : runningQuoteRequested
          ? "已定位 running 对话"
        : decision
          ? decision.action === "steer"
            ? "已选择 steer"
            : "已选择 stack"
          : sessionPick
            ? "已选择会话"
            : "已选择项目",
    );
    logTelegramDebug("callback_query.dispatch_inbound", {
      callbackId: redactValue(callbackId),
      chatId: redactValue(chatId),
      text: inbound.text,
      hasMetadata: Boolean(inbound.metadata),
    });
    void handler(inbound).catch((error) => {
      logTelegramDebug("callback_query.handler_error", {
        callbackId: redactValue(callbackId),
        error: error instanceof Error ? error.message : String(error),
      });
      // Isolate per-message handler failures from polling loop.
    });
  }

  private acknowledgeCallbackQuery(callbackId: string, text?: string): void {
    void this.answerCallbackQuery(callbackId, text).catch((error) => {
      logTelegramDebug("callback_query.ack_failed", {
        callbackId: redactValue(callbackId),
        error: error instanceof Error ? error.message : String(error),
      });
      // Best-effort acknowledgement.
    });
  }

  private async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackId,
    };
    const normalized = text?.trim();
    if (normalized) {
      payload.text = normalized;
    }
    await this.callApi<boolean>("answerCallbackQuery", payload);
  }

  private async runPollLoop(handler: ChannelInboundHandler, signal: AbortSignal): Promise<void> {
    logTelegramDebug("pollLoop.started", {
      retryDelayMs: this.retryDelayMs,
      pollTimeoutSeconds: this.pollTimeoutSeconds,
    });
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.fetchUpdates(signal);
        logTelegramDebug("pollLoop.updates_received", {
          count: updates.length,
          currentOffset: this.offset,
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const callbackQuery = update.callback_query;
          if (callbackQuery) {
            void this.handleCallbackQuery(callbackQuery, handler).catch((error) => {
              logTelegramDebug("pollLoop.callback_handler_error", {
                error: error instanceof Error ? error.message : String(error),
              });
              // Isolate callback handling failures from polling loop.
            });
            continue;
          }
          const message = update.message ?? update.edited_message;
          if (!message) {
            continue;
          }
          if (message.from?.is_bot) {
            continue;
          }

          const chatId = String(message.chat.id);
          if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
            continue;
          }

          const text = resolveInboundText(message);
          let attachments: DownloadedTelegramAttachments = {
            attachmentPaths: [],
            imagePaths: [],
            kinds: [],
            errors: [],
          };
          try {
            attachments = await this.downloadAttachmentPaths(message, signal);
          } catch (error) {
            attachments.errors.push(error instanceof Error ? error.message : String(error));
            logTelegramDebug("pollLoop.attachment_download_unhandled_error", {
              chatId: redactValue(chatId),
              messageId: redactValue(normalizeOptionalString(message.message_id)),
              error: error instanceof Error ? error.message : String(error),
            });
          }

          if (!text) {
            continue;
          }

          const inbound: ChannelInboundMessage = {
            channelId: this.id,
            chatId,
            text,
            raw: update,
          };
          const senderId = normalizeOptionalString(message.from?.id);
          if (senderId) {
            inbound.senderId = senderId;
          }
          const senderName = message.from?.username || message.from?.first_name;
          if (senderName) {
            inbound.senderName = senderName;
          }
          const messageId = normalizeOptionalString(message.message_id);
          if (messageId) {
            inbound.messageId = messageId;
          }
          const threadId = normalizeOptionalString(message.message_thread_id);
          if (threadId) {
            inbound.threadId = threadId;
          }
          const replyToMessageId = normalizeOptionalString(message.reply_to_message?.message_id);
          if (replyToMessageId) {
            inbound.replyToMessageId = replyToMessageId;
          }
          if (attachments.attachmentPaths.length > 0) {
            inbound.attachmentPaths = attachments.attachmentPaths;
          }
          if (attachments.imagePaths.length > 0) {
            inbound.imagePaths = attachments.imagePaths;
          }
          if (
            attachments.attachmentPaths.length > 0 ||
            attachments.imagePaths.length > 0 ||
            attachments.kinds.length > 0 ||
            attachments.errors.length > 0
          ) {
            inbound.metadata = {
              telegram_attachment_count: attachments.attachmentPaths.length,
              telegram_image_count: attachments.imagePaths.length,
              telegram_attachment_kinds: attachments.kinds,
              ...(isVoiceOnlyInput(message)
                ? {
                    telegram_voice_only_input: true,
                  }
                : {}),
              ...(attachments.errors.length > 0
                ? {
                    telegram_attachment_download_errors: attachments.errors,
                  }
                : {}),
            };
          }
          void handler(inbound).catch((error) => {
            logTelegramDebug("pollLoop.inbound_handler_error", {
              chatId: redactValue(chatId),
              messageId: redactValue(inbound.messageId),
              error: error instanceof Error ? error.message : String(error),
            });
            // Isolate per-message handler failures from polling loop.
          });
        }
      } catch (error) {
        if (signal.aborted || !this.running) {
          logTelegramDebug("pollLoop.stopped", {
            reason: signal.aborted ? "aborted" : "not_running",
          });
          return;
        }
        logTelegramDebug("pollLoop.error", {
          retryDelayMs: this.retryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        // Keep polling loop alive on transient network/api failures.
        await sleep(this.retryDelayMs);
      }
    }
    logTelegramDebug("pollLoop.exited", {
      reason: this.running ? "signal_aborted" : "stopped",
    });
  }

  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const payload = {
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ["message", "edited_message", "callback_query"],
    };
    logTelegramDebug("fetchUpdates.request", {
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
    });
    const response = await this.callApi<TelegramUpdate[]>("getUpdates", payload, signal);
    logTelegramDebug("fetchUpdates.response", {
      count: response.length,
    });
    return response;
  }

  private async registerBotCommands(): Promise<void> {
    logTelegramDebug("registerBotCommands.request", {
      commandCount: TELEGRAM_COMMANDS.length,
    });
    await this.callApi<boolean>("setMyCommands", {
      commands: TELEGRAM_COMMANDS,
    });
    logTelegramDebug("registerBotCommands.response_ok", {});
  }

  private async downloadAttachmentPaths(
    message: TelegramMessage,
    signal: AbortSignal,
  ): Promise<DownloadedTelegramAttachments> {
    const candidates = resolveAttachmentCandidates(message);
    const messageId = normalizeOptionalString(message.message_id);
    logTelegramDebug("attachment.download_candidates", {
      messageId: redactValue(messageId),
      candidateCount: candidates.length,
    });
    if (candidates.length === 0) {
      return {
        attachmentPaths: [],
        imagePaths: [],
        kinds: [],
        errors: [],
      };
    }

    const downloaded: DownloadedTelegramAttachments = {
      attachmentPaths: [],
      imagePaths: [],
      kinds: [],
      errors: [],
    };

    for (const candidate of candidates) {
      try {
        logTelegramDebug("attachment.download_candidate_begin", {
          messageId: redactValue(messageId),
          kind: candidate.kind,
          fileId: redactValue(candidate.fileId),
        });
        const file = await this.callApi<TelegramFile>("getFile", { file_id: candidate.fileId }, signal);
        const remotePath = file.file_path?.trim();
        if (!remotePath) {
          logTelegramDebug("attachment.download_candidate_missing_path", {
            messageId: redactValue(messageId),
            kind: candidate.kind,
            fileId: redactValue(candidate.fileId),
          });
          downloaded.errors.push(`${candidate.kind}: missing file_path`);
          continue;
        }
        const localPath = await this.downloadTelegramFile(remotePath, candidate.defaultExt, signal);
        logTelegramDebug("attachment.download_candidate_succeeded", {
          messageId: redactValue(messageId),
          kind: candidate.kind,
          fileId: redactValue(candidate.fileId),
          localPath,
        });
        downloaded.attachmentPaths.push(localPath);
        downloaded.kinds.push(candidate.kind);
        if (candidate.isImage) {
          downloaded.imagePaths.push(localPath);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logTelegramDebug("attachment.download_candidate_failed", {
          messageId: redactValue(messageId),
          kind: candidate.kind,
          fileId: redactValue(candidate.fileId),
          error: reason,
        });
        downloaded.errors.push(`${candidate.kind}: ${reason}`);
      }
    }

    return {
      attachmentPaths: [...new Set(downloaded.attachmentPaths)],
      imagePaths: [...new Set(downloaded.imagePaths)],
      kinds: [...new Set(downloaded.kinds)],
      errors: downloaded.errors,
    };
  }

  private async downloadTelegramFile(
    remotePath: string,
    fallbackExt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const normalized = remotePath.replace(/^\/+/, "");
    const url = `${this.apiBaseUrl}/file/bot${this.token}/${normalized}`;
    const startedAt = Date.now();
    logTelegramDebug("file_download.request", {
      remotePath: normalized,
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: signal ?? null,
      });
    } catch (error) {
      logTelegramDebug("file_download.network_error", {
        remotePath: normalized,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (!response.ok) {
      logTelegramDebug("file_download.http_error", {
        remotePath: normalized,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`telegram file download failed: status=${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const ext = normalizeExtensionCandidate(path.extname(normalized));
    const safeExt = ext ?? normalizeExtensionCandidate(fallbackExt) ?? ".bin";
    const root = path.join(os.tmpdir(), "opencarapace", "telegram-media");
    await mkdir(root, { recursive: true });
    const localPath = path.join(root, `${Date.now()}-${randomUUID()}${safeExt}`);
    await writeFile(localPath, bytes);
    logTelegramDebug("file_download.succeeded", {
      remotePath: normalized,
      localPath,
      bytes: bytes.length,
      durationMs: Date.now() - startedAt,
    });
    return localPath;
  }

  private async callApi<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    const startedAt = Date.now();
    logTelegramDebug("api.request", {
      method,
      payloadKeys: Object.keys(payload),
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: signal ?? null,
      });
    } catch (error) {
      logTelegramDebug("api.network_error", {
        method,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const details = parseTelegramHttpErrorBody(bodyText);
      const retryAfterHeaderSeconds = parseRetryAfterFromHeader(response.headers.get("retry-after"));
      const retryAfterSeconds = retryAfterHeaderSeconds ?? details.retryAfterSeconds;
      logTelegramDebug("api.http_error", {
        method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorCode: details.errorCode,
        retryAfterSeconds,
        retryAfterHeaderSeconds,
        description: details.description,
        bodyPreview: details.bodyPreview,
      });
      if (
        isRateLimitedErrorShape({
          status: response.status,
          errorCode: details.errorCode,
          retryAfterSeconds,
        })
      ) {
        throw new TelegramRateLimitError({
          method,
          retryAfterSeconds: resolveRetryAfterSeconds(retryAfterSeconds),
          status: response.status,
          ...(details.description ? { description: details.description } : {}),
        });
      }
      const retrySuffix =
        retryAfterSeconds === undefined ? "" : ` retry_after=${retryAfterSeconds}`;
      const descriptionSuffix = details.description ? `: ${details.description}` : "";
      throw new Error(
        `telegram api request failed (${method}): status=${response.status}${retrySuffix}${descriptionSuffix}`,
      );
    }
    let json: TelegramApiEnvelope<T>;
    try {
      json = (await response.json()) as TelegramApiEnvelope<T>;
    } catch (error) {
      logTelegramDebug("api.json_parse_error", {
        method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logTelegramDebug("api.http_ok", {
      method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return this.unwrapEnvelope(method, json);
  }

  private async callMultipartApi<T>(
    method: string,
    payload: FormData,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    const startedAt = Date.now();
    logTelegramDebug("api.multipart_request", {
      method,
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        body: payload,
        signal: signal ?? null,
      });
    } catch (error) {
      logTelegramDebug("api.network_error", {
        method,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const details = parseTelegramHttpErrorBody(bodyText);
      const retryAfterHeaderSeconds = parseRetryAfterFromHeader(response.headers.get("retry-after"));
      const retryAfterSeconds = retryAfterHeaderSeconds ?? details.retryAfterSeconds;
      logTelegramDebug("api.http_error", {
        method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorCode: details.errorCode,
        retryAfterSeconds,
        retryAfterHeaderSeconds,
        description: details.description,
        bodyPreview: details.bodyPreview,
      });
      if (
        isRateLimitedErrorShape({
          status: response.status,
          errorCode: details.errorCode,
          retryAfterSeconds,
        })
      ) {
        throw new TelegramRateLimitError({
          method,
          retryAfterSeconds: resolveRetryAfterSeconds(retryAfterSeconds),
          status: response.status,
          ...(details.description ? { description: details.description } : {}),
        });
      }
      const retrySuffix =
        retryAfterSeconds === undefined ? "" : ` retry_after=${retryAfterSeconds}`;
      const descriptionSuffix = details.description ? `: ${details.description}` : "";
      throw new Error(
        `telegram api request failed (${method}): status=${response.status}${retrySuffix}${descriptionSuffix}`,
      );
    }
    let json: TelegramApiEnvelope<T>;
    try {
      json = (await response.json()) as TelegramApiEnvelope<T>;
    } catch (error) {
      logTelegramDebug("api.json_parse_error", {
        method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logTelegramDebug("api.http_ok", {
      method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return this.unwrapEnvelope(method, json);
  }

  private unwrapEnvelope<T>(method: string, envelope: TelegramApiEnvelope<T>): T {
    if (!envelope.ok || envelope.result === undefined) {
      const errorCode =
        typeof envelope.error_code === "number" && Number.isFinite(envelope.error_code)
          ? Math.floor(envelope.error_code)
          : undefined;
      const retryAfterSeconds = parseRetryAfterFromErrorEnvelope(envelope);
      if (
        isRateLimitedErrorShape({
          status: undefined,
          errorCode,
          retryAfterSeconds,
        })
      ) {
        throw new TelegramRateLimitError({
          method,
          retryAfterSeconds: resolveRetryAfterSeconds(retryAfterSeconds),
          ...(errorCode !== undefined ? { status: errorCode } : {}),
          ...(envelope.description ? { description: envelope.description } : {}),
        });
      }
      logTelegramDebug("api.envelope_error", {
        method,
        errorCode,
        retryAfterSeconds,
        description: envelope.description ?? "unknown error",
      });
      throw new Error(
        `telegram api response failed (${method}): ${envelope.description || "unknown error"}`,
      );
    }
    return envelope.result;
  }
}
