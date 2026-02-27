import { loadOpenCarapaceConfig, resolveOpenCarapaceConfigPath } from "../config/index";
import { createDefaultOrchestrator } from "../index";

export async function runServer(options?: { configPath?: string }): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error("This server must run with Bun runtime.");
  }

  const configPath = resolveOpenCarapaceConfigPath(options?.configPath);
  const config = loadOpenCarapaceConfig({ path: configPath });
  const orchestrator = createDefaultOrchestrator({ config, configPath });
  const port = Math.max(1, config.runtime?.port ?? 3000);

  Bun.serve({
    port,
    routes: {
      "/health": () => {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      "/chat": {
        POST: async (request: Request) => {
          try {
            const body = (await request.json()) as {
              agentId?: string;
              sessionId?: string;
              input?: string;
              metadata?: Record<string, unknown>;
            };

            if (!body.sessionId || !body.input) {
              return new Response(
                JSON.stringify({ error: "sessionId and input are required" }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            const chatParams = {
              sessionId: body.sessionId,
              input: body.input,
            } as {
              sessionId: string;
              input: string;
              agentId?: string;
              metadata?: Record<string, unknown>;
            };
            if (body.agentId) {
              chatParams.agentId = body.agentId;
            }
            if (body.metadata) {
              chatParams.metadata = body.metadata;
            }

            const result = await orchestrator.chat(chatParams);

            return new Response(JSON.stringify(result), {
              headers: { "content-type": "application/json" },
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              {
                status: 500,
                headers: { "content-type": "application/json" },
              },
            );
          }
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`open-carapace server running on :${port}`);
}

if (import.meta.main) {
  void runServer();
}
