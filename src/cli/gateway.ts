import { BridgeChannelAdapter, type BridgeInboundPayload } from "../channels/bridge.js";
import { loadOpenCarapaceConfig, resolveOpenCarapaceConfigPath } from "../config/index.js";
import { createDefaultChannelGateway } from "../index.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function extractBridgeSecret(request: Request): string | undefined {
  const direct = request.headers.get("x-channel-secret")?.trim();
  if (direct) {
    return direct;
  }
  const auth = request.headers.get("authorization")?.trim();
  if (!auth) {
    return undefined;
  }
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return undefined;
}

export async function runGateway(options?: { configPath?: string }): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error("Gateway must run with Bun runtime.");
  }

  const configPath = resolveOpenCarapaceConfigPath(options?.configPath);
  const config = loadOpenCarapaceConfig({ path: configPath });
  const gateway = createDefaultChannelGateway({ config, configPath });
  const registry = gateway.registry;

  const channels = registry.list();
  if (channels.length === 0) {
    throw new Error(
      "No channel adapters configured. Please enable channels in ~/.config/opencarapace/config.toml.",
    );
  }

  await gateway.start();

  const port = Math.max(1, config.runtime?.gateway_port ?? 3010);
  const server = Bun.serve({
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json({
          ok: true,
          channels: channels.map((channel) => channel.id),
        });
      }

      const match = /^\/channels\/([a-z0-9-]+)\/inbound$/.exec(url.pathname);
      if (request.method === "POST" && match) {
        const channelId = match[1];
        if (!channelId) {
          return json({ error: "invalid channel path" }, 400);
        }
        const adapter = registry.get(channelId);
        if (!adapter || !(adapter instanceof BridgeChannelAdapter)) {
          return json({ error: `inbound bridge channel not enabled: ${channelId}` }, 404);
        }

        let payload: BridgeInboundPayload;
        try {
          payload = (await request.json()) as BridgeInboundPayload;
        } catch {
          return json({ error: "invalid json body" }, 400);
        }

        const accepted = await adapter.ingestInbound(payload, extractBridgeSecret(request));
        if (!accepted) {
          return json({ error: "rejected inbound message" }, 401);
        }
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    },
  });

  let shuttingDown = false;
  let forcedExitCode = 0;
  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shuttingDown) {
      process.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    shuttingDown = true;
    const timeout = setTimeout(() => {
      process.exit(forcedExitCode || 1);
    }, 3000);
    timeout.unref?.();
    try {
      await gateway.stop();
    } catch (error) {
      forcedExitCode = 1;
      console.error(
        `gateway shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      server.stop(true);
      clearTimeout(timeout);
    }
    process.exit(forcedExitCode);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.log(`open-carapace channel gateway running on :${port}`);
  console.log(`active channels: ${channels.map((channel) => channel.id).join(", ")}`);
}

if (import.meta.main) {
  void runGateway();
}
