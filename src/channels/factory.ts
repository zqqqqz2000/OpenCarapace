import type { AgentId } from "../core/types.js";
import { ChannelRegistry } from "./registry.js";
import { createDiscordBridgeAdapterFromEnv, createSlackBridgeAdapterFromEnv, createWeChatBridgeAdapterFromEnv } from "./bridge.js";
import { TelegramChannelAdapter } from "./telegram.js";
import type { ChannelAgentRouting, ChannelId } from "./types.js";

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createDefaultChannelRegistryFromEnv(): ChannelRegistry {
  const registry = new ChannelRegistry();

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (token) {
    const telegram = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? 25),
      retryDelayMs: Number(process.env.TELEGRAM_RETRY_DELAY_MS ?? 1200),
      allowedChatIds: splitCsv(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    });
    registry.register(telegram);
  }

  const slack = createSlackBridgeAdapterFromEnv();
  if (slack) {
    registry.register(slack);
  }

  const discord = createDiscordBridgeAdapterFromEnv();
  if (discord) {
    registry.register(discord);
  }

  const wechat = createWeChatBridgeAdapterFromEnv();
  if (wechat) {
    registry.register(wechat);
  }

  return registry;
}

export function resolveChannelAgentRoutingFromEnv(): ChannelAgentRouting {
  const defaultAgentId = (process.env.CHANNEL_DEFAULT_AGENT_ID?.trim() || "codex") as AgentId;
  const perChannel: Partial<Record<ChannelId, AgentId>> = {};

  const routingPairs = splitCsv(process.env.CHANNEL_AGENT_ROUTING);
  for (const pair of routingPairs) {
    const separator = pair.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const channelId = pair.slice(0, separator).trim() as ChannelId;
    const agentId = pair.slice(separator + 1).trim() as AgentId;
    if (!channelId || !agentId) {
      continue;
    }
    perChannel[channelId] = agentId;
  }

  return {
    defaultAgentId,
    perChannel,
  };
}
