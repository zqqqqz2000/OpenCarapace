import { describe, expect, test } from "bun:test";
import { ChannelGateway } from "../../src/channels/gateway.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type {
  ChannelAdapter,
  ChannelEditMessage,
  ChannelOutboundMessage,
  ChannelSendReceipt,
} from "../../src/channels/types.js";
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
});
