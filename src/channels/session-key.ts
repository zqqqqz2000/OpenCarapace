import type { ChannelInboundMessage } from "./types.js";

export const DEFAULT_CHANNEL_SESSION_PROJECT_KEY = "main";

function compactContext(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return encodeURIComponent(normalized);
}

export function normalizeChannelSessionProjectKey(projectKey: string | undefined): string {
  const normalized = (projectKey ?? "").trim();
  if (!normalized) {
    return DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
  }
  return encodeURIComponent(normalized);
}

export function decodeChannelSessionProjectKey(projectKey: string): string {
  const normalized = projectKey.trim();
  if (!normalized) {
    return DEFAULT_CHANNEL_SESSION_PROJECT_KEY;
  }
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

export function buildChannelConversationKey(
  message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
): string {
  const channel = compactContext(message.channelId, "unknown");
  const chat = compactContext(message.chatId, "chat");
  const thread = compactContext(message.threadId, "main");
  return `${channel}.${chat}.${thread}`;
}

export function buildChannelSessionId(
  message: Pick<ChannelInboundMessage, "channelId" | "chatId" | "threadId">,
  options?: { projectKey?: string },
): string {
  const project = normalizeChannelSessionProjectKey(options?.projectKey);
  return `agent.${project}.${buildChannelConversationKey(message)}`;
}

export function parseChannelSessionId(
  sessionId: string,
): { projectKey: string; conversationKey: string } | null {
  const normalized = sessionId.trim();
  if (!normalized.startsWith("agent.")) {
    return null;
  }
  const body = normalized.slice("agent.".length);
  const firstDot = body.indexOf(".");
  if (firstDot <= 0) {
    return null;
  }
  const projectKey = body.slice(0, firstDot).trim();
  const conversationKey = body.slice(firstDot + 1).trim();
  if (!projectKey || !conversationKey) {
    return null;
  }
  return {
    projectKey,
    conversationKey,
  };
}
