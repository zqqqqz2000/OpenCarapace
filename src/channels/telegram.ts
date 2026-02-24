import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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
  { command: "new", description: "Reset current session and start new turn chain" },
  { command: "history", description: "Show recent messages in this session" },
  { command: "session", description: "Show current session metadata" },
  { command: "sessions", description: "List recent sessions" },
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
      return;
    }

    try {
      await this.registerBotCommands();
    } catch {
      // Best-effort: message polling should continue even if command registration fails.
    }

    this.running = true;
    this.abort = new AbortController();
    this.runner = this.runPollLoop(handler, this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abort) {
      this.abort.abort();
    }
    const active = this.runner;
    this.abort = null;
    this.runner = null;
    if (active) {
      await active.catch(() => {});
    }
  }

  async sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt> {
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
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const replyTo = normalizeOptionalInt(message.replyToMessageId);
    if (replyTo !== undefined) {
      payload.reply_to_message_id = replyTo;
    }

    const threadId = normalizeOptionalInt(message.threadId);
    if (threadId !== undefined) {
      payload.message_thread_id = threadId;
    }

    const response = await this.callApi<TelegramMessage>("sendMessage", payload);
    const receipt: ChannelSendReceipt = {
      raw: response,
    };
    const messageId = normalizeOptionalString(response.message_id);
    if (messageId) {
      receipt.messageId = messageId;
    }
    return receipt;
  }

  async editMessage(message: ChannelEditMessage): Promise<ChannelSendReceipt> {
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

    let response: TelegramMessage | undefined;
    try {
      response = await this.callApi<TelegramMessage>("editMessageText", payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/message is not modified/i.test(reason)) {
        return {};
      }
      throw error;
    }
    const receipt: ChannelSendReceipt = {
      raw: response,
    };
    const messageId = normalizeOptionalString(response.message_id);
    if (messageId) {
      receipt.messageId = messageId;
    }
    return receipt;
  }

  async sendFile(attachment: ChannelFileAttachment): Promise<ChannelSendReceipt> {
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

    const response = await this.callMultipartApi<TelegramMessage>("sendDocument", payload);
    const receipt: ChannelSendReceipt = {
      raw: response,
    };
    const messageId = normalizeOptionalString(response.message_id);
    if (messageId) {
      receipt.messageId = messageId;
    }
    return receipt;
  }

  private async handleCallbackQuery(
    callbackQuery: TelegramCallbackQuery,
    handler: ChannelInboundHandler,
  ): Promise<void> {
    const callbackId = callbackQuery.id?.trim();
    const rawData = callbackQuery.data?.trim();
    const message = callbackQuery.message;
    if (!callbackId || !rawData || !message) {
      return;
    }

    const decision = parseTurnDecisionCallbackData(rawData);
    const stopRequested = isTurnRunningStopCallbackData(rawData);
    if (!decision && !stopRequested) {
      this.acknowledgeCallbackQuery(callbackId);
      return;
    }

    const chatId = String(message.chat.id);
    if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
      this.acknowledgeCallbackQuery(callbackId);
      return;
    }

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      chatId,
      text: stopRequested ? "/stop" : "/turn-decision",
      raw: callbackQuery,
    };
    if (decision) {
      inbound.metadata = {
        [TURN_DECISION_META_ACTION]: decision.action,
        [TURN_DECISION_META_TOKEN]: decision.token,
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
      stopRequested ? "已请求 stop" : decision?.action === "steer" ? "已选择 steer" : "已选择 stack",
    );
    void handler(inbound).catch(() => {
      // Isolate per-message handler failures from polling loop.
    });
  }

  private acknowledgeCallbackQuery(callbackId: string, text?: string): void {
    void this.answerCallbackQuery(callbackId, text).catch(() => {
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
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.fetchUpdates(signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const callbackQuery = update.callback_query;
          if (callbackQuery) {
            void this.handleCallbackQuery(callbackQuery, handler).catch(() => {
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
          void handler(inbound).catch(() => {
            // Isolate per-message handler failures from polling loop.
          });
        }
      } catch (error) {
        if (signal.aborted || !this.running) {
          return;
        }
        // Keep polling loop alive on transient network/api failures.
        await sleep(this.retryDelayMs);
      }
    }
  }

  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const payload = {
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ["message", "edited_message", "callback_query"],
    };
    const response = await this.callApi<TelegramUpdate[]>("getUpdates", payload, signal);
    return response;
  }

  private async registerBotCommands(): Promise<void> {
    await this.callApi<boolean>("setMyCommands", {
      commands: TELEGRAM_COMMANDS,
    });
  }

  private async downloadAttachmentPaths(
    message: TelegramMessage,
    signal: AbortSignal,
  ): Promise<DownloadedTelegramAttachments> {
    const candidates = resolveAttachmentCandidates(message);
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
        const file = await this.callApi<TelegramFile>("getFile", { file_id: candidate.fileId }, signal);
        const remotePath = file.file_path?.trim();
        if (!remotePath) {
          downloaded.errors.push(`${candidate.kind}: missing file_path`);
          continue;
        }
        const localPath = await this.downloadTelegramFile(remotePath, candidate.defaultExt, signal);
        downloaded.attachmentPaths.push(localPath);
        downloaded.kinds.push(candidate.kind);
        if (candidate.isImage) {
          downloaded.imagePaths.push(localPath);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
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
    const response = await fetch(url, {
      method: "GET",
      signal: signal ?? null,
    });

    if (!response.ok) {
      throw new Error(`telegram file download failed: status=${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const ext = normalizeExtensionCandidate(path.extname(normalized));
    const safeExt = ext ?? normalizeExtensionCandidate(fallbackExt) ?? ".bin";
    const root = path.join(os.tmpdir(), "opencarapace", "telegram-media");
    await mkdir(root, { recursive: true });
    const localPath = path.join(root, `${Date.now()}-${randomUUID()}${safeExt}`);
    await writeFile(localPath, bytes);
    return localPath;
  }

  private async callApi<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: signal ?? null,
    });

    if (!response.ok) {
      throw new Error(`telegram api request failed (${method}): status=${response.status}`);
    }
    const json = (await response.json()) as TelegramApiEnvelope<T>;
    return this.unwrapEnvelope(method, json);
  }

  private async callMultipartApi<T>(
    method: string,
    payload: FormData,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      body: payload,
      signal: signal ?? null,
    });

    if (!response.ok) {
      throw new Error(`telegram api request failed (${method}): status=${response.status}`);
    }
    const json = (await response.json()) as TelegramApiEnvelope<T>;
    return this.unwrapEnvelope(method, json);
  }

  private unwrapEnvelope<T>(method: string, envelope: TelegramApiEnvelope<T>): T {
    if (!envelope.ok || envelope.result === undefined) {
      throw new Error(
        `telegram api response failed (${method}): ${envelope.description || "unknown error"}`,
      );
    }
    return envelope.result;
  }
}
