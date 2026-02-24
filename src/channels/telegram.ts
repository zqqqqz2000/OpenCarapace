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

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  text?: string;
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
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
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
          if (!message.text?.trim()) {
            continue;
          }
          if (message.from?.is_bot) {
            continue;
          }

          const chatId = String(message.chat.id);
          if (this.allowedChatIds && !this.allowedChatIds.has(chatId)) {
            continue;
          }

          const inbound: ChannelInboundMessage = {
            channelId: this.id,
            chatId,
            text: message.text.trim(),
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
