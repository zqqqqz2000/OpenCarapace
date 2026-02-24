import { BaseCodeAgentAdapter } from "./base.js";
import { CliAgentBackend, type AgentBackend, SdkAgentBackend } from "./backend.js";
import type { AgentEventSink, AgentTurnRequest } from "../core/types.js";

export class DeterministicCodexBackend extends SdkAgentBackend {
  constructor() {
    super(async (request, sink) => {
      const tips = [
        "正在读取任务上下文...",
        "正在拆分可执行步骤...",
        "正在生成简明结果...",
      ];

      for (const tip of tips) {
        await sink({
          type: "command",
          command: {
            name: "progress",
            payload: { text: tip },
          },
          at: Date.now(),
        });
      }

      const shortTask = request.prompt.length > 80 ? `${request.prompt.slice(0, 80)}...` : request.prompt;
      const finalText = [
        "结果",
        `1. 已按任务目标处理：${shortTask}`,
        "2. 已尽量减少额外输出，仅保留可执行信息。",
        "过程",
        "1. 分析输入与上下文。",
        "2. 组织步骤并检查可读性。",
        "下一步",
        "1. 若你愿意，我可以继续给出更细的执行清单。",
      ].join("\n");

      return {
        finalText,
      };
    });
  }
}

export type CodexAdapterOptions = {
  backend?: AgentBackend;
};

export class CodexAgentAdapter extends BaseCodeAgentAdapter {
  constructor(options: CodexAdapterOptions = {}) {
    super({
      id: "codex",
      displayName: "Codex",
      backend: options.backend ?? new DeterministicCodexBackend(),
      capabilities: {
        transports: ["sdk", "cli", "hook"],
        streaming: true,
        supportsCommands: true,
        supportsMemoryHints: true,
      },
    });
  }

  protected async prelude(request: AgentTurnRequest, sink: AgentEventSink): Promise<void> {
    await sink({
      type: "status",
      phase: "thinking",
      message: "Codex 正在理解任务并准备执行路径。",
      at: Date.now(),
    });

    await sink({
      type: "command",
      command: {
        name: "notify",
        payload: {
          text: `收到任务：${request.prompt.slice(0, 80)}${request.prompt.length > 80 ? "..." : ""}`,
        },
      },
      at: Date.now(),
    });
  }
}

export function createCodexCliBackendFromEnv(): AgentBackend | null {
  return createCodexCliBackend();
}

export function createCodexCliBackend(params?: {
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
