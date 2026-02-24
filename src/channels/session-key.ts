import type { ChannelInboundMessage } from "./types.js";

function compact(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return encodeURIComponent(normalized);
}

export function buildChannelSessionId(message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">): string {
  const channel = compact(message.channelId, "unknown");
  const chat = compact(message.chatId, "chat");
  const thread = compact(message.threadId, "main");
  return `agent.main.${channel}.${chat}.${thread}`;
}
