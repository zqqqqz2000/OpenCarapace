import type { AgentId } from "../core/types";
import type { OpenCarapaceConfig } from "../config/types";
import { resolveSecretValue } from "../config/secrets";
import { ChannelRegistry } from "./registry";
import { BridgeChannelAdapter } from "./bridge";
import { TelegramChannelAdapter } from "./telegram";
import type { ChannelAgentRouting, ChannelId } from "./types";

function normalizeRoutedAgentId(raw: string | undefined): AgentId | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "codex" || normalized === "claude-code") {
    return normalized;
  }
  return undefined;
}

function resolveSecret(params: {
  value: string | undefined;
  file: string | undefined;
  configFilePath: string | undefined;
}): string | undefined {
  const input = {} as {
    value?: string;
    file?: string;
    configFilePath?: string;
  };
  if (params.value) {
    input.value = params.value;
  }
  if (params.file) {
    input.file = params.file;
  }
  if (params.configFilePath) {
    input.configFilePath = params.configFilePath;
  }
  return resolveSecretValue(input);
}

export function createChannelRegistryFromConfig(params?: {
  config?: OpenCarapaceConfig;
  configFilePath?: string;
}): ChannelRegistry {
  const config = params?.config;
  const registry = new ChannelRegistry();

  const telegramConfig = config?.channels?.telegram;
  const token = resolveSecret({
    value: telegramConfig?.token,
    file: telegramConfig?.token_file,
    configFilePath: params?.configFilePath,
  });
  const telegramEnabled = telegramConfig?.enabled ?? Boolean(token);
  if (token) {
    if (telegramEnabled) {
      const telegram = new TelegramChannelAdapter({
        token,
        pollTimeoutSeconds: telegramConfig?.poll_timeout_seconds ?? 25,
        retryDelayMs: telegramConfig?.retry_delay_ms ?? 1200,
        allowedChatIds: (telegramConfig?.allowed_chat_ids ?? []).map((item) => item.trim()).filter(Boolean),
      });
      registry.register(telegram);
    }
  }

  const slackEnabled = config?.channels?.slack?.enabled ?? false;
  if (slackEnabled) {
    const slackOptions = {
      id: "slack",
      displayName: "Slack (Bridge)",
      maxMessageChars: 3000,
      supportsThreads: true,
    } as {
      id: "slack";
      displayName: string;
      maxMessageChars: number;
      supportsThreads: boolean;
      inboundSecret?: string;
      outboundWebhookUrl?: string;
    };
    const inboundSecret = resolveSecret({
      value: config?.channels?.slack?.inbound_secret,
      file: config?.channels?.slack?.inbound_secret_file,
      configFilePath: params?.configFilePath,
    });
    if (inboundSecret) {
      slackOptions.inboundSecret = inboundSecret;
    }
    const outboundWebhookUrl = resolveSecret({
      value: config?.channels?.slack?.outbound_webhook_url,
      file: config?.channels?.slack?.outbound_webhook_url_file,
      configFilePath: params?.configFilePath,
    });
    if (outboundWebhookUrl) {
      slackOptions.outboundWebhookUrl = outboundWebhookUrl;
    }
    registry.register(
      new BridgeChannelAdapter(slackOptions),
    );
  }

  const discordEnabled = config?.channels?.discord?.enabled ?? false;
  if (discordEnabled) {
    const discordOptions = {
      id: "discord",
      displayName: "Discord (Bridge)",
      maxMessageChars: 1900,
      supportsThreads: true,
    } as {
      id: "discord";
      displayName: string;
      maxMessageChars: number;
      supportsThreads: boolean;
      inboundSecret?: string;
      outboundWebhookUrl?: string;
    };
    const inboundSecret = resolveSecret({
      value: config?.channels?.discord?.inbound_secret,
      file: config?.channels?.discord?.inbound_secret_file,
      configFilePath: params?.configFilePath,
    });
    if (inboundSecret) {
      discordOptions.inboundSecret = inboundSecret;
    }
    const outboundWebhookUrl = resolveSecret({
      value: config?.channels?.discord?.outbound_webhook_url,
      file: config?.channels?.discord?.outbound_webhook_url_file,
      configFilePath: params?.configFilePath,
    });
    if (outboundWebhookUrl) {
      discordOptions.outboundWebhookUrl = outboundWebhookUrl;
    }
    registry.register(
      new BridgeChannelAdapter(discordOptions),
    );
  }

  return registry;
}

export function resolveChannelAgentRoutingFromConfig(config?: OpenCarapaceConfig): ChannelAgentRouting {
  const defaultAgentId =
    normalizeRoutedAgentId(config?.channels?.routing?.default_agent_id) ??
    normalizeRoutedAgentId(config?.runtime?.default_agent_id) ??
    "codex";
  const perChannel: Partial<Record<ChannelId, AgentId>> = {};

  const configEntries = config?.channels?.routing?.entries ?? {};
  for (const [channelIdRaw, agentIdRaw] of Object.entries(configEntries)) {
    const channelId = channelIdRaw.trim() as ChannelId;
    const agentId = normalizeRoutedAgentId(agentIdRaw);
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

// Backward-compatible export names.
export function createDefaultChannelRegistryFromEnv(config?: OpenCarapaceConfig): ChannelRegistry {
  const params = {} as {
    config?: OpenCarapaceConfig;
  };
  if (config) {
    params.config = config;
  }
  return createChannelRegistryFromConfig(params);
}

// Backward-compatible export names.
export function resolveChannelAgentRoutingFromEnv(config?: OpenCarapaceConfig): ChannelAgentRouting {
  return resolveChannelAgentRoutingFromConfig(config);
}
