import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createChannelRegistryFromConfig, resolveChannelAgentRoutingFromConfig } from "../../src/channels/factory.js";
import type { OpenCarapaceConfig } from "../../src/config/types.js";

describe("channel factory from config", () => {
  test("loads telegram and bridge channels with file-backed secrets", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-channel-test-"));
    const telegramTokenPath = path.join(dir, "telegram.token");
    const slackSecretPath = path.join(dir, "slack.secret");
    writeFileSync(telegramTokenPath, "123:bot-token\n", "utf-8");
    writeFileSync(slackSecretPath, "slack-bridge-secret\n", "utf-8");

    const config: OpenCarapaceConfig = {
      channels: {
        telegram: {
          enabled: true,
          token_file: "./telegram.token",
        },
        slack: {
          enabled: true,
          inbound_secret_file: "./slack.secret",
          outbound_webhook_url: "https://example.com/slack-webhook",
        },
      },
    };

    const registry = createChannelRegistryFromConfig({
      config,
      configFilePath: path.join(dir, "config.toml"),
    });

    const ids = registry.list().map((channel) => channel.id).sort();
    expect(ids).toEqual(["slack", "telegram"]);
  });

  test("resolves channel routing map from config only", () => {
    const routing = resolveChannelAgentRoutingFromConfig({
      runtime: {
        default_agent_id: "codex",
      },
      channels: {
        routing: {
          entries: {
            telegram: "codex",
            slack: "claude-code",
          },
        },
      },
    });

    expect(routing.defaultAgentId).toBe("codex");
    expect(routing.perChannel?.telegram).toBe("codex");
    expect(routing.perChannel?.slack).toBe("claude-code");
  });

  test("drops invalid routed agents and keeps valid ones", () => {
    const routing = resolveChannelAgentRoutingFromConfig({
      runtime: {
        default_agent_id: "legacy-cloudcode",
      },
      channels: {
        routing: {
          entries: {
            slack: "cloudcode",
            discord: "claude-code",
          },
        },
      },
    });

    expect(routing.defaultAgentId).toBe("codex");
    expect(routing.perChannel?.slack).toBeUndefined();
    expect(routing.perChannel?.discord).toBe("claude-code");
  });
});
