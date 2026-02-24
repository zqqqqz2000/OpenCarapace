import { describe, expect, test } from "bun:test";
import { ChannelGateway } from "../../src/channels/gateway.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type {
  ChannelAdapter,
  ChannelEditMessage,
  ChannelOutboundMessage,
  ChannelSendReceipt,
} from "../../src/channels/types.js";
import type { AgentAdapter } from "../../src/core/agent.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { TurnAbortedError } from "../../src/core/abort.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import type { AgentEventSink, AgentTurnRequest, AgentTurnResult } from "../../src/core/types.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";
import { createDeterministicOrchestrator } from "../support/orchestrator.js";

class CaptureChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly displayName = "Capture";
  readonly capabilities = {
    supportsMessageEdit: true,
    maxMessageChars: 4000,
    supportsThreads: true,
  };

  readonly sent: ChannelOutboundMessage[] = [];
  readonly edited: ChannelEditMessage[] = [];

  private nextId = 1;

  async sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt> {
    this.sent.push(message);
    return { messageId: String(this.nextId++) };
  }

  async editMessage(message: ChannelEditMessage): Promise<ChannelSendReceipt> {
    this.edited.push(message);
    return { messageId: message.messageId };
  }
}

class SlowAbortableCodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "SlowCodex";
  readonly capabilities = {
    streaming: true,
    transports: ["sdk"] as Array<"sdk" | "cli" | "hook">,
    supportsCommands: true,
    supportsMemoryHints: true,
  };

  private seq = 0;

  async runTurn(_request: AgentTurnRequest, sink: AgentEventSink): Promise<AgentTurnResult> {
    this.seq += 1;
    const id = this.seq;

    await sink({
      type: "status",
      phase: "thinking",
      message: `slow-turn-${id}`,
      at: Date.now(),
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 700);
      const signal = _request.abortSignal;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new TurnAbortedError(`aborted-${id}`));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    });

    await sink({
      type: "delta",
      text: `done-${id}`,
      at: Date.now(),
    });
    return {
      finalText: `done-${id}`,
      raw: {
        sessionMetadata: {
          codex_thread_id: `slow-thread-${id}`,
        },
      },
    };
  }
}

function createSlowOrchestrator(adapter: AgentAdapter): ChatOrchestrator {
  const registry = new AgentRegistry();
  registry.register(adapter);
  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore: new InMemorySessionStore(),
    readabilityPolicy: new ReadabilityPolicy({
      maxChars: 800,
      maxLines: 12,
    }),
    defaultAgentId: "codex",
  });
}

describe("ChannelGateway", () => {
  test("sends progress updates and final text during long turn", async () => {
    const adapter = new CaptureChannelAdapter();
    const registry = new ChannelRegistry();
    registry.register(adapter);

    const gateway = new ChannelGateway({
      orchestrator: createDeterministicOrchestrator(),
      registry,
      routing: {
        defaultAgentId: "codex",
      },
    });

    const result = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-1",
      messageId: "12",
      text: "请给我一个发布任务计划，最好有过程提示。",
    });

    expect(result.finalText.length).toBeGreaterThan(0);
    expect(adapter.edited.length).toBeGreaterThan(0);
    expect(adapter.sent.some((message) => message.text.includes("⏳"))).toBeTrue();
    expect(adapter.sent.some((message) => message.text.includes("结果"))).toBeTrue();
  });

  test("supports slash command messages through channel", async () => {
    const adapter = new CaptureChannelAdapter();
    const registry = new ChannelRegistry();
    registry.register(adapter);

    const gateway = new ChannelGateway({
      orchestrator: createDeterministicOrchestrator(),
      registry,
      routing: {
        defaultAgentId: "codex",
      },
    });

    await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-cmd",
      messageId: "33",
      text: "/help",
    });

    expect(adapter.sent.some((message) => message.text.includes("Available commands"))).toBeTrue();
  });

  test("steers to latest non-command input by interrupting the running turn", async () => {
    const adapter = new CaptureChannelAdapter();
    const registry = new ChannelRegistry();
    registry.register(adapter);

    const gateway = new ChannelGateway({
      orchestrator: createSlowOrchestrator(new SlowAbortableCodexAdapter()),
      registry,
      routing: {
        defaultAgentId: "codex",
      },
    });

    const firstPromise = gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-steer",
      messageId: "100",
      text: "先处理这个很慢的任务",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const secondResult = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-steer",
      messageId: "101",
      text: "改成处理这个最新任务",
    });

    const firstResult = await firstPromise;

    expect(firstResult.finalText).toBe("");
    expect(secondResult.finalText).toContain("done-2");
    expect(
      adapter.sent.some((message) => message.text.includes("已收到新消息，正在中断当前任务并按最新输入继续。")),
    ).toBeTrue();
    expect(
      adapter.sent.some((message) => message.text.includes("任务执行失败")),
    ).toBeFalse();
  });

  test("runs slash commands in parallel while a non-command turn is running", async () => {
    const adapter = new CaptureChannelAdapter();
    const registry = new ChannelRegistry();
    registry.register(adapter);

    const gateway = new ChannelGateway({
      orchestrator: createSlowOrchestrator(new SlowAbortableCodexAdapter()),
      registry,
      routing: {
        defaultAgentId: "codex",
      },
    });

    const runningTurn = gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-parallel-cmd",
      messageId: "200",
      text: "一个慢任务",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const commandTurn = gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-parallel-cmd",
      messageId: "201",
      text: "/status",
    });

    const fast = await Promise.race([
      commandTurn.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(fast).toBe("resolved");
    await runningTurn;
    const statusReply = adapter.sent.find((message) => message.text.includes("Conversation status"));
    expect(statusReply).toBeDefined();
  });
});
