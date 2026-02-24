import { BaseCodeAgentAdapter } from "./base.js";
import { CliAgentBackend, HookAgentBackend, type AgentBackend } from "./backend.js";
import type { AgentEventSink, AgentTurnRequest } from "../core/types.js";

export class ClaudeCodeAgentAdapter extends BaseCodeAgentAdapter {
  constructor(backend?: AgentBackend) {
    super({
      id: "claude-code",
      displayName: "Claude Code",
      backend:
        backend ??
        new HookAgentBackend(async () => {
          throw new Error(
            "Claude Code backend is not configured. Set agents.claude_code.cli_command in config.toml.",
          );
        }),
      capabilities: {
        transports: ["sdk", "cli", "hook"],
      },
    });
  }

  protected async prelude(_request: AgentTurnRequest, sink: AgentEventSink): Promise<void> {
    await sink({
      type: "status",
      phase: "thinking",
      message: "Claude Code 正在审阅上下文并准备执行。",
      at: Date.now(),
    });

    await sink({
      type: "command",
      command: {
        name: "progress",
        payload: { text: "Claude Code: 已完成风险检查，准备落地。" },
      },
      at: Date.now(),
    });
  }
}

export function createClaudeCodeCliBackend(params?: {
  command?: string;
  args?: string[];
}): AgentBackend | null {
  const command = params?.command?.trim();
  if (!command) {
    return null;
  }

  const args = (params?.args ?? []).map((part) => part.trim()).filter(Boolean);
  return new CliAgentBackend({
    command,
    args,
    promptMode: "arg",
    promptArgToken: "{{prompt}}",
  });
}
