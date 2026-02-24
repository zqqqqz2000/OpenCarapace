import type { AgentId } from "../core/types.js";
import type { OpenCarapaceConfig } from "../config/types.js";
import { resolveSecretValue } from "../config/secrets.js";
import { ChannelRegistry } from "./registry.js";
import { BridgeChannelAdapter } from "./bridge.js";
import { TelegramChannelAdapter } from "./telegram.js";
import type { ChannelAgentRouting, ChannelId } from "./types.js";

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

  const wechatEnabled = config?.channels?.wechat?.enabled ?? false;
  if (wechatEnabled) {
    const wechatOptions = {
      id: "wechat",
      displayName: "WeChat (Bridge)",
      maxMessageChars: 1500,
      supportsThreads: false,
    } as {
      id: "wechat";
      displayName: string;
      maxMessageChars: number;
      supportsThreads: boolean;
      inboundSecret?: string;
      outboundWebhookUrl?: string;
    };
    const inboundSecret = resolveSecret({
      value: config?.channels?.wechat?.inbound_secret,
      file: config?.channels?.wechat?.inbound_secret_file,
      configFilePath: params?.configFilePath,
    });
    if (inboundSecret) {
      wechatOptions.inboundSecret = inboundSecret;
    }
    const outboundWebhookUrl = resolveSecret({
      value: config?.channels?.wechat?.outbound_webhook_url,
      file: config?.channels?.wechat?.outbound_webhook_url_file,
      configFilePath: params?.configFilePath,
    });
    if (outboundWebhookUrl) {
      wechatOptions.outboundWebhookUrl = outboundWebhookUrl;
    }
    registry.register(
      new BridgeChannelAdapter(wechatOptions),
    );
  }

  return registry;
}

export function resolveChannelAgentRoutingFromConfig(config?: OpenCarapaceConfig): ChannelAgentRouting {
  const defaultAgentId = (
    config?.channels?.routing?.default_agent_id?.trim() ||
    config?.runtime?.default_agent_id?.trim() ||
    "codex"
  ) as AgentId;
  const perChannel: Partial<Record<ChannelId, AgentId>> = {};

  const configEntries = config?.channels?.routing?.entries ?? {};
  for (const [channelIdRaw, agentIdRaw] of Object.entries(configEntries)) {
    const channelId = channelIdRaw.trim() as ChannelId;
    const agentId = agentIdRaw.trim() as AgentId;
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
