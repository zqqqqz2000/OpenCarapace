import { BaseCodeAgentAdapter } from "./base.js";
import { CliAgentBackend, HookAgentBackend, type AgentBackend } from "./backend.js";
import type { AgentEventSink, AgentTurnRequest } from "../core/types.js";

export class CloudCodeAgentAdapter extends BaseCodeAgentAdapter {
  constructor(backend?: AgentBackend) {
    super({
      id: "cloudcode",
      displayName: "CloudCode",
      backend:
        backend ??
        new HookAgentBackend(async () => {
          throw new Error(
            "CloudCode backend is not configured. Set agents.cloudcode.cli_command in config.toml.",
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
      message: "CloudCode 正在进行任务规划。",
      at: Date.now(),
    });

    await sink({
      type: "command",
      command: {
        name: "progress",
        payload: { text: "CloudCode: 已完成初步计划，准备执行。" },
      },
      at: Date.now(),
    });
  }
}

export function createCloudCodeCliBackend(params?: {
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
