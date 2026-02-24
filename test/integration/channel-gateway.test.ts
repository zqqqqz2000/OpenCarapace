import { describe, expect, test } from "bun:test";
import { ChannelGateway } from "../../src/channels/gateway.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type {
  ChannelAdapter,
  ChannelEditMessage,
  ChannelFileAttachment,
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
import {
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_TOKEN,
  parseTurnDecisionCallbackData,
} from "../../src/channels/turn-decision.js";
import { createDeterministicOrchestrator } from "../support/orchestrator.js";

class CaptureChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly displayName = "Capture";
  readonly capabilities: {
    supportsMessageEdit: true;
    maxMessageChars: number;
    supportsThreads: true;
  };

  readonly sent: ChannelOutboundMessage[] = [];
  readonly edited: ChannelEditMessage[] = [];
  readonly files: ChannelFileAttachment[] = [];

  private nextId = 1;

  constructor(maxMessageChars = 4000) {
    this.capabilities = {
      supportsMessageEdit: true,
      maxMessageChars,
      supportsThreads: true,
    };
  }

  async sendMessage(message: ChannelOutboundMessage): Promise<ChannelSendReceipt> {
    this.sent.push(message);
    return { messageId: String(this.nextId++) };
  }

  async editMessage(message: ChannelEditMessage): Promise<ChannelSendReceipt> {
    this.edited.push(message);
    return { messageId: message.messageId };
  }

  async sendFile(attachment: ChannelFileAttachment): Promise<ChannelSendReceipt> {
    this.files.push(attachment);
    return { messageId: String(this.nextId++) };
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

class LongCodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "LongCodex";
  readonly capabilities = {
    streaming: true,
    transports: ["sdk"] as Array<"sdk" | "cli" | "hook">,
    supportsCommands: true,
    supportsMemoryHints: true,
  };

  constructor(private readonly finalText: string) {}

  async runTurn(_request: AgentTurnRequest, _sink: AgentEventSink): Promise<AgentTurnResult> {
    return {
      finalText: this.finalText,
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

function createLongOutputOrchestrator(finalText: string): ChatOrchestrator {
  const registry = new AgentRegistry();
  registry.register(new LongCodexAdapter(finalText));
  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore: new InMemorySessionStore(),
    readabilityPolicy: new ReadabilityPolicy({
      maxChars: 140,
      maxLines: 4,
    }),
    defaultAgentId: "codex",
  });
}

function findTurnDecisionCallback(
  messages: ChannelOutboundMessage[],
  action: "steer" | "stack",
): string {
  for (const message of messages) {
    const metadata = message.metadata as
      | {
          telegram_reply_markup?: {
            inline_keyboard?: Array<Array<{ callback_data?: string }>>;
          };
        }
      | undefined;
    const rows = metadata?.telegram_reply_markup?.inline_keyboard ?? [];
    for (const row of rows) {
      for (const button of row) {
        const callbackData = button.callback_data;
        if (!callbackData) {
          continue;
        }
        const parsed = parseTurnDecisionCallbackData(callbackData);
        if (parsed && parsed.action === action) {
          return parsed.token;
        }
      }
    }
  }
  throw new Error(`missing callback token for action=${action}`);
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

  test("animates running message by editing progress text repeatedly", async () => {
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

    const result = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-running-anim",
      messageId: "anim-1",
      text: "请执行一个慢任务并展示过程",
    });

    expect(result.finalText).toContain("done-1");
    const spinnerEdits = adapter.edited
      .map((message) => message.text)
      .filter((text) => text.startsWith("⏳ ["));
    expect(spinnerEdits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(spinnerEdits).size).toBeGreaterThan(1);
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

  test("shows steer/stack choices when new non-command input arrives during a running turn", async () => {
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
      chatId: "chat-steer-choice",
      messageId: "100",
      text: "先处理这个很慢的任务",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const secondResult = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-steer-choice",
      messageId: "101",
      text: "这是运行中的新消息",
    });

    expect(secondResult.finalText).toBe("");
    const token = findTurnDecisionCallback(adapter.sent, "steer");
    expect(token.length).toBeGreaterThan(0);
    const prompt = adapter.sent.find((message) => message.text.includes("steer") && message.text.includes("stack"));
    expect(prompt).toBeDefined();

    await firstPromise;
  });

  test("applies steer option to interrupt current turn and switch to latest message", async () => {
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

    const steerToken = findTurnDecisionCallback(adapter.sent, "steer");
    const steerResult = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-steer",
      messageId: "102",
      text: "/turn-decision",
      metadata: {
        [TURN_DECISION_META_ACTION]: "steer",
        [TURN_DECISION_META_TOKEN]: steerToken,
      },
    });

    const firstResult = await firstPromise;

    expect(secondResult.finalText).toBe("");
    expect(firstResult.finalText).toBe("");
    expect(steerResult.finalText).toContain("done-2");
    expect(
      adapter.sent.some((message) => message.text.includes("已选择 1. steer")),
    ).toBeTrue();
    expect(
      adapter.sent.some((message) => message.text.includes("任务执行失败")),
    ).toBeFalse();
  });

  test("applies stack option to queue latest message behind running turn", async () => {
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
      chatId: "chat-stack",
      messageId: "110",
      text: "慢任务先跑",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const queued = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-stack",
      messageId: "111",
      text: "后续排队任务",
    });
    expect(queued.finalText).toBe("");

    const stackToken = findTurnDecisionCallback(adapter.sent, "stack");
    const stackedResult = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-stack",
      messageId: "112",
      text: "/turn-decision",
      metadata: {
        [TURN_DECISION_META_ACTION]: "stack",
        [TURN_DECISION_META_TOKEN]: stackToken,
      },
    });

    const firstResult = await firstPromise;
    expect(firstResult.finalText).toContain("done-1");
    expect(stackedResult.finalText).toContain("done-2");
    expect(adapter.sent.some((message) => message.text.includes("已选择 2. stack"))).toBeTrue();
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

  test("interrupts running turn via /stop command", async () => {
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
      chatId: "chat-stop",
      messageId: "300",
      text: "先跑一个慢任务",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const stopTurn = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-stop",
      messageId: "301",
      text: "/stop",
    });

    const firstResult = await runningTurn;
    expect(firstResult.finalText).toBe("");
    expect(stopTurn.finalText).toContain("Stop signal sent.");
    expect(adapter.sent.some((message) => message.text.includes("Stop signal sent."))).toBeTrue();
  });

  test("marks running sessions in /sessions while a turn is active", async () => {
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
      chatId: "chat-running-sessions",
      messageId: "run-1",
      text: "慢任务进行中",
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const sessionsTurn = await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-running-sessions",
      messageId: "run-2",
      text: "/sessions",
    });

    expect(sessionsTurn.finalText).toContain("[RUNNING]");
    expect(adapter.sent.some((message) => message.text.includes("[RUNNING]"))).toBeTrue();
    await runningTurn;
  });

  test("sends tail-preview plus full-text attachment for long telegram replies", async () => {
    const adapter = new CaptureChannelAdapter(220);
    const registry = new ChannelRegistry();
    registry.register(adapter);
    const longText = Array.from(
      { length: 100 },
      (_, index) => `${index + 1}. line-${index + 1} long output block for telegram attachment test.`,
    ).join("\n");

    const gateway = new ChannelGateway({
      orchestrator: createLongOutputOrchestrator(longText),
      registry,
      routing: {
        defaultAgentId: "codex",
      },
    });

    await gateway.handleInbound({
      channelId: "telegram",
      chatId: "chat-long",
      messageId: "901",
      text: "请返回完整结果",
    });

    const finals = adapter.sent.filter((message) => !message.text.startsWith("⏳"));
    expect(finals.length).toBeGreaterThan(0);
    const preview = finals[finals.length - 1]?.text ?? "";
    expect(preview.startsWith("…")).toBeTrue();
    expect(preview).toContain("line-100");
    expect(preview).not.toContain("line-1 long");
    expect(preview.length).toBeLessThanOrEqual(300);

    expect(adapter.files.length).toBe(1);
    const file = adapter.files[0];
    if (!file) {
      throw new Error("missing attachment");
    }
    expect(file.fileName.endsWith(".txt")).toBeTrue();
    expect(typeof file.content).toBe("string");
    if (typeof file.content !== "string") {
      throw new Error("expected string attachment content");
    }
    expect(file.content).toBe(longText);
    expect(file.caption).toContain("完整版");
  });
});
