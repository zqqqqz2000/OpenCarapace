import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEditMessage,
  ChannelInboundHandler,
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelSendReceipt,
  ChannelId,
} from "./types.js";

export type BridgeInboundPayload = {
  accountId?: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  threadId?: string;
  replyToMessageId?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
};

export type BridgeChannelAdapterOptions = {
  id: ChannelId;
  displayName: string;
  inboundSecret?: string;
  outboundWebhookUrl?: string;
  maxMessageChars?: number;
  supportsThreads?: boolean;
};

export class BridgeChannelAdapter implements ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly capabilities: ChannelCapabilities;

  private readonly inboundSecret: string | null;
  private readonly outboundWebhookUrl: string | null;
  private inboundHandler: ChannelInboundHandler | null = null;

  constructor(options: BridgeChannelAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.inboundSecret = options.inboundSecret?.trim() || null;
    this.outboundWebhookUrl = options.outboundWebhookUrl?.trim() || null;
    this.capabilities = {
      supportsMessageEdit: false,
      maxMessageChars: Math.max(200, options.maxMessageChars ?? 3000),
      supportsThreads: options.supportsThreads ?? true,
    };
  }

  async start(handler: ChannelInboundHandler): Promise<void> {
    this.inboundHandler = handler;
  }

  async stop(): Promise<void> {
    this.inboundHandler = null;
  }

  async sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt> {
    if (!this.outboundWebhookUrl) {
      return {};
    }
    const response = await fetch(this.outboundWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channelId: this.id,
        accountId: message.accountId,
        chatId: message.chatId,
        threadId: message.threadId,
        replyToMessageId: message.replyToMessageId,
        text: message.text,
        metadata: message.metadata,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `${this.id} bridge outbound webhook failed: status=${response.status} ${response.statusText}`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return {
      raw: json,
    };
  }

  async editMessage(_message: ChannelEditMessage): Promise<ChannelSendReceipt> {
    return {};
  }

  async ingestInbound(payload: BridgeInboundPayload, providedSecret?: string): Promise<boolean> {
    if (!this.inboundHandler) {
      return false;
    }

    if (this.inboundSecret && providedSecret !== this.inboundSecret) {
      return false;
    }

    const text = (payload.text ?? "").trim();
    const chatId = (payload.chatId ?? "").trim();
    if (!text || !chatId) {
      return false;
    }

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      chatId,
      text,
      raw: payload.raw ?? payload,
    };
    if (payload.accountId) {
      inbound.accountId = payload.accountId;
    }
    if (payload.senderId) {
      inbound.senderId = payload.senderId;
    }
    if (payload.senderName) {
      inbound.senderName = payload.senderName;
    }
    if (payload.messageId) {
      inbound.messageId = payload.messageId;
    }
    if (payload.threadId) {
      inbound.threadId = payload.threadId;
    }
    if (payload.replyToMessageId) {
      inbound.replyToMessageId = payload.replyToMessageId;
    }
    if (payload.metadata) {
      inbound.metadata = payload.metadata;
    }
    await this.inboundHandler(inbound);
    return true;
  }
}

export function createSlackBridgeAdapterFromEnv(): BridgeChannelAdapter | null {
  const enabled = process.env.SLACK_BRIDGE_ENABLED === "1";
  if (!enabled) {
    return null;
  }
  const options: BridgeChannelAdapterOptions = {
    id: "slack",
    displayName: "Slack (Bridge)",
    maxMessageChars: 3000,
    supportsThreads: true,
  };
  if (process.env.SLACK_BRIDGE_INBOUND_SECRET) {
    options.inboundSecret = process.env.SLACK_BRIDGE_INBOUND_SECRET;
  }
  if (process.env.SLACK_BRIDGE_OUTBOUND_WEBHOOK_URL) {
    options.outboundWebhookUrl = process.env.SLACK_BRIDGE_OUTBOUND_WEBHOOK_URL;
  }
  return new BridgeChannelAdapter(options);
}

export function createDiscordBridgeAdapterFromEnv(): BridgeChannelAdapter | null {
  const enabled = process.env.DISCORD_BRIDGE_ENABLED === "1";
  if (!enabled) {
    return null;
  }
  const options: BridgeChannelAdapterOptions = {
    id: "discord",
    displayName: "Discord (Bridge)",
    maxMessageChars: 1900,
    supportsThreads: true,
  };
  if (process.env.DISCORD_BRIDGE_INBOUND_SECRET) {
    options.inboundSecret = process.env.DISCORD_BRIDGE_INBOUND_SECRET;
  }
  if (process.env.DISCORD_BRIDGE_OUTBOUND_WEBHOOK_URL) {
    options.outboundWebhookUrl = process.env.DISCORD_BRIDGE_OUTBOUND_WEBHOOK_URL;
  }
  return new BridgeChannelAdapter(options);
}

export function createWeChatBridgeAdapterFromEnv(): BridgeChannelAdapter | null {
  const enabled = process.env.WECHAT_BRIDGE_ENABLED === "1";
  if (!enabled) {
    return null;
  }
  const options: BridgeChannelAdapterOptions = {
    id: "wechat",
    displayName: "WeChat (Bridge)",
    maxMessageChars: 1500,
    supportsThreads: false,
  };
  if (process.env.WECHAT_BRIDGE_INBOUND_SECRET) {
    options.inboundSecret = process.env.WECHAT_BRIDGE_INBOUND_SECRET;
  }
  if (process.env.WECHAT_BRIDGE_OUTBOUND_WEBHOOK_URL) {
    options.outboundWebhookUrl = process.env.WECHAT_BRIDGE_OUTBOUND_WEBHOOK_URL;
  }
  return new BridgeChannelAdapter(options);
}
