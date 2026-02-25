import { loadOpenCarapaceConfig, resolveOpenCarapaceConfigPath } from "../config/index.js";
import { createDefaultOrchestrator } from "../index.js";

function usage(): string {
  return [
    "Usage:",
    "  bun run src/cli/chat.ts <sessionId> <message> [--agent <agentId>]",
    "  bun run src/cli/chat.ts <agentId> <sessionId> <message>   # backward compatible",
    "Example:",
    "  bun run src/cli/chat.ts demo \"帮我整理一个发布计划\" --agent codex",
    "  bun run src/cli/chat.ts demo \"/status\"",
  ].join("\n");
}

function parseArgs(argv: string[]): { sessionId: string; input: string; agentId?: string } | null {
  if (argv.length < 2) {
    return null;
  }

  const args = [...argv];
  let agentId: string | undefined;
  const flagIndex = args.findIndex((arg) => arg === "--agent");
  if (flagIndex >= 0) {
    agentId = args[flagIndex + 1];
    if (!agentId) {
      return null;
    }
    args.splice(flagIndex, 2);
  }

  if (args.length < 2) {
    return null;
  }

  if (!agentId && args.length >= 3) {
    const legacyCandidate = args[0];
    if (legacyCandidate === "codex" || legacyCandidate === "claude-code") {
      agentId = legacyCandidate;
      args.shift();
    }
  }

  const sessionId = args[0];
  if (!sessionId) {
    return null;
  }

  const input = args.slice(1).join(" ").trim();
  if (!input) {
    return null;
  }

  const parsed = {
    sessionId,
    input,
  } as { sessionId: string; input: string; agentId?: string };
  if (agentId) {
    parsed.agentId = agentId;
  }
  return parsed;
}

export async function runChatCli(
  argv: string[] = process.argv.slice(2),
  options?: { configPath?: string },
): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const orchestrator = (() => {
    if (!options?.configPath) {
      return createDefaultOrchestrator();
    }
    const configPath = resolveOpenCarapaceConfigPath(options.configPath);
    return createDefaultOrchestrator({
      configPath,
      config: loadOpenCarapaceConfig({ path: configPath }),
    });
  })();
  const request = {
    sessionId: parsed.sessionId,
    input: parsed.input,
  } as {
    sessionId: string;
    input: string;
    agentId?: string;
  };
  if (parsed.agentId) {
    request.agentId = parsed.agentId;
  }
  const result = await orchestrator.chat(request);

  for (const event of result.events) {
    if (event.type === "status") {
      console.log(`[status:${event.phase}] ${event.message}`);
    }
    if (event.type === "command") {
      console.log(`[command:${event.command.name}] ${JSON.stringify(event.command.payload)}`);
    }
  }

  console.log("\n=== Final ===");
  console.log(result.finalText);
}

if (import.meta.main) {
  void runChatCli();
}
