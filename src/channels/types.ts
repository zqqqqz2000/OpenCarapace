import type { AgentId, AgentEvent } from "../core/types";

export type ChannelId =
  | "telegram"
  | "slack"
  | "discord"
  | (string & {});

export type ChannelInboundMessage = {
  channelId: ChannelId;
  accountId?: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  threadId?: string;
  replyToMessageId?: string;
  text: string;
  attachmentPaths?: string[];
  imagePaths?: string[];
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type ChannelOutboundMessage = {
  channelId: ChannelId;
  accountId?: string;
  chatId: string;
  text: string;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
};

export type ChannelEditMessage = {
  channelId: ChannelId;
  accountId?: string;
  chatId: string;
  messageId: string;
  text: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
};

export type ChannelFileAttachment = {
  channelId: ChannelId;
  accountId?: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  fileName: string;
  content: string | Uint8Array;
  mimeType?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
};

export type ChannelSendReceipt = {
  messageId?: string;
  raw?: unknown;
};

export type ChannelCapabilities = {
  supportsMessageEdit: boolean;
  maxMessageChars: number;
  supportsThreads: boolean;
};

export type ChannelInboundHandler = (message: ChannelInboundMessage) => Promise<void>;

export type ChannelEventObserver = (event: AgentEvent) => Promise<void> | void;

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly capabilities: ChannelCapabilities;
  start?(handler: ChannelInboundHandler): Promise<void>;
  stop?(): Promise<void>;
  isOutboundBusy?(chatId?: string): boolean;
  sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt>;
  editMessage?(message: ChannelEditMessage): Promise<ChannelSendReceipt>;
  sendFile?(attachment: ChannelFileAttachment): Promise<ChannelSendReceipt>;
}

export type ChannelAgentRouting = {
  defaultAgentId: AgentId;
  perChannel?: Partial<Record<ChannelId, AgentId>>;
};
