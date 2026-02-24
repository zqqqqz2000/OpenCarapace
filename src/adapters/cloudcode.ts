import { BaseCodeAgentAdapter } from "./base.js";
import { HookAgentBackend, type AgentBackend } from "./backend.js";
import type { AgentEventSink, AgentTurnRequest } from "../core/types.js";

export class CloudCodeAgentAdapter extends BaseCodeAgentAdapter {
  constructor(backend?: AgentBackend) {
    super({
      id: "cloudcode",
      displayName: "CloudCode",
      backend:
        backend ??
        new HookAgentBackend(async () => {
          return {
            finalText: "CloudCode adapter is wired. Connect a real backend via SDK/CLI/Hook.",
          };
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
