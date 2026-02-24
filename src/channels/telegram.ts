import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEditMessage,
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
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: {
    message_id: number;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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

function resolveInboundText(message: TelegramMessage): string {
  const text = message.text?.trim();
  if (text) {
    return text;
  }

  const caption = message.caption?.trim();
  if (caption) {
    return caption;
  }

  if (message.photo?.length) {
    return "请基于附带图片进行处理。";
  }

  return "";
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
    const threadId = normalizeOptionalInt(message.threadId);
    if (threadId !== undefined) {
      payload.message_thread_id = threadId;
    }

    const response = await this.callApi<TelegramMessage>("editMessageText", payload);
    const receipt: ChannelSendReceipt = {
      raw: response,
    };
    const messageId = normalizeOptionalString(response.message_id);
    if (messageId) {
      receipt.messageId = messageId;
    }
    return receipt;
  }

  private async runPollLoop(handler: ChannelInboundHandler, signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.fetchUpdates(signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
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
          let imagePaths: string[] = [];
          let imageDownloadError = "";
          try {
            imagePaths = await this.downloadImagePaths(message, signal);
          } catch (error) {
            imageDownloadError = error instanceof Error ? error.message : String(error);
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
          if (imagePaths.length > 0) {
            inbound.imagePaths = imagePaths;
            inbound.metadata = {
              telegram_image_count: imagePaths.length,
            };
          } else if (imageDownloadError) {
            inbound.metadata = {
              telegram_image_download_error: imageDownloadError,
            };
          }
          await handler(inbound);
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
      allowed_updates: ["message", "edited_message"],
    };
    const response = await this.callApi<TelegramUpdate[]>("getUpdates", payload, signal);
    return response;
  }

  private async downloadImagePaths(
    message: TelegramMessage,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (!message.photo?.length) {
      return [];
    }
    const selected = pickLargestPhoto(message.photo);
    const fileId = selected?.file_id?.trim();
    if (!fileId) {
      return [];
    }
    const file = await this.callApi<TelegramFile>("getFile", { file_id: fileId }, signal);
    const remotePath = file.file_path?.trim();
    if (!remotePath) {
      return [];
    }
    const localPath = await this.downloadTelegramFile(remotePath, signal);
    return [localPath];
  }

  private async downloadTelegramFile(remotePath: string, signal: AbortSignal): Promise<string> {
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
    const ext = path.extname(normalized).trim();
    const safeExt = ext && ext.length <= 10 ? ext : ".jpg";
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
    if (!json.ok || json.result === undefined) {
      throw new Error(
        `telegram api response failed (${method}): ${json.description || "unknown error"}`,
      );
    }
    return json.result;
  }
}
