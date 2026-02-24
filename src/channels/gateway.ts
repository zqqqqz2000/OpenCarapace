import { ChatOrchestrator } from "../core/orchestrator.js";
import type { AgentEvent, AgentId, ChatTurnResult } from "../core/types.js";
import { ChannelRegistry } from "./registry.js";
import { buildChannelSessionId } from "./session-key.js";
import type {
  ChannelAdapter,
  ChannelAgentRouting,
  ChannelEditMessage,
  ChannelId,
  ChannelInboundHandler,
  ChannelInboundMessage,
  ChannelOutboundMessage,
} from "./types.js";

const DEFAULT_PROGRESS_THROTTLE_MS = 1200;
const DEFAULT_DELTA_PREVIEW_MAX_CHARS = 180;

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitOutboundText(text: string, maxChars: number): string[] {
  const normalizedMax = Math.max(200, maxChars);
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = "";
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= normalizedMax) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (line.length <= normalizedMax) {
      current = line;
      continue;
    }

    let offset = 0;
    while (offset < line.length) {
      chunks.push(line.slice(offset, offset + normalizedMax));
      offset += normalizedMax;
    }
  }

  pushCurrent();
  return chunks;
}

function resolveCommandText(event: Extract<AgentEvent, { type: "command" }>): string | undefined {
  const payloadText = event.command.payload.text;
  if (typeof payloadText === "string") {
    return payloadText.trim();
  }
  return undefined;
}

type TurnRelayOptions = {
  progressThrottleMs?: number;
  deltaPreviewMaxChars?: number;
};

class ChannelTurnRelay {
  private progressMessageId: string | undefined;
  private readonly seenStatus = new Set<string>();
  private deltaBuffer = "";
  private lastProgressAt = 0;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly inbound: ChannelInboundMessage,
    private readonly options: TurnRelayOptions = {},
  ) {}

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "status":
        await this.handleStatus(event);
        return;
      case "command":
        await this.handleCommand(event);
        return;
      case "delta":
        await this.handleDelta(event.text);
        return;
      case "error":
        await this.sendProgress(`任务执行出错：${event.error}`);
        return;
      case "result":
        return;
      default:
        return;
    }
  }

  async finalize(result: ChatTurnResult): Promise<void> {
    await this.flushDeltaPreview(true);

    const chunks = splitOutboundText(
      result.finalText,
      Math.max(300, this.adapter.capabilities.maxMessageChars),
    );
    if (chunks.length === 0) {
      await this.sendText("暂无可读结果，请重试。");
      return;
    }

    for (const chunk of chunks) {
      await this.sendText(chunk);
    }
  }

  private async handleStatus(event: Extract<AgentEvent, { type: "status" }>): Promise<void> {
    // Keep status notifications short and avoid repeatedly spamming the same phase.
    if (this.seenStatus.has(event.phase)) {
      return;
    }
    this.seenStatus.add(event.phase);
    if (event.phase === "completed") {
      return;
    }
    await this.sendProgress(event.message);
  }

  private async handleCommand(event: Extract<AgentEvent, { type: "command" }>): Promise<void> {
    if (event.command.name !== "progress" && event.command.name !== "notify") {
      return;
    }
    const text = resolveCommandText(event);
    if (!text) {
      return;
    }
    await this.sendProgress(text);
  }

  private async handleDelta(text: string): Promise<void> {
    const normalized = compactWhitespace(text);
    if (!normalized) {
      return;
    }
    this.deltaBuffer = compactWhitespace(`${this.deltaBuffer} ${normalized}`);
    await this.flushDeltaPreview(false);
  }

  private async flushDeltaPreview(force: boolean): Promise<void> {
    if (!this.deltaBuffer) {
      return;
    }

    const throttleMs = this.options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < throttleMs) {
      return;
    }

    const maxChars = this.options.deltaPreviewMaxChars ?? DEFAULT_DELTA_PREVIEW_MAX_CHARS;
    const preview = clipText(this.deltaBuffer, maxChars);
    this.deltaBuffer = "";
    await this.sendProgress(`处理中：${preview}`);
  }

  private async sendProgress(text: string): Promise<void> {
    const normalized = clipText(compactWhitespace(text), 400);
    if (!normalized) {
      return;
    }
    this.lastProgressAt = Date.now();

    if (this.adapter.capabilities.supportsMessageEdit && this.progressMessageId && this.adapter.editMessage) {
      const edit: ChannelEditMessage = {
        channelId: this.adapter.id,
        chatId: this.inbound.chatId,
        messageId: this.progressMessageId,
        text: `⏳ ${normalized}`,
      };
      if (this.inbound.accountId) {
        edit.accountId = this.inbound.accountId;
      }
      if (this.inbound.threadId) {
        edit.threadId = this.inbound.threadId;
      }
      await this.adapter.editMessage(edit);
      return;
    }

    const sent = await this.sendText(`⏳ ${normalized}`);
    if (this.adapter.capabilities.supportsMessageEdit && sent.messageId) {
      this.progressMessageId = sent.messageId;
    }
  }

  private async sendText(text: string): Promise<{ messageId?: string }> {
    const outbound: ChannelOutboundMessage = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      text,
    };
    if (this.inbound.accountId) {
      outbound.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      outbound.threadId = this.inbound.threadId;
    }
    if (this.inbound.messageId) {
      outbound.replyToMessageId = this.inbound.messageId;
    }
    return await this.adapter.sendMessage(outbound);
  }
}

export type ChannelGatewayDeps = {
  orchestrator: ChatOrchestrator;
  registry?: ChannelRegistry;
  routing: ChannelAgentRouting;
};

export class ChannelGateway {
  readonly orchestrator: ChatOrchestrator;
  readonly registry: ChannelRegistry;
  readonly routing: ChannelAgentRouting;

  constructor(deps: ChannelGatewayDeps) {
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry ?? new ChannelRegistry();
    this.routing = deps.routing;
  }

  registerChannel(adapter: ChannelAdapter): this {
    this.registry.register(adapter);
    return this;
  }

  async start(): Promise<void> {
    const handler: ChannelInboundHandler = async (message) => {
      await this.handleInbound(message);
    };

    for (const channel of this.registry.list()) {
      if (channel.start) {
        await channel.start(handler);
      }
    }
  }

  async stop(): Promise<void> {
    for (const channel of this.registry.list()) {
      if (channel.stop) {
        await channel.stop();
      }
    }
  }

  async handleInbound(message: ChannelInboundMessage): Promise<ChatTurnResult> {
    const channel = this.registry.require(message.channelId);
    const sessionId = buildChannelSessionId(message);
    const agentId = this.resolveAgentId(message.channelId);
    const relay = new ChannelTurnRelay(channel, message);

    try {
      const result = await this.orchestrator.chat({
        agentId,
        sessionId,
        input: message.text,
        metadata: {
          channelId: message.channelId,
          accountId: message.accountId,
          chatId: message.chatId,
          senderId: message.senderId,
          senderName: message.senderName,
          threadId: message.threadId,
          messageId: message.messageId,
          replyToMessageId: message.replyToMessageId,
          imagePaths: message.imagePaths,
          rawInbound: message.raw,
          ...(message.metadata ?? {}),
        },
        onEvent: async (event) => {
          await relay.onEvent(event);
        },
      });

      await relay.finalize(result);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failure: ChannelOutboundMessage = {
        channelId: channel.id,
        chatId: message.chatId,
        text: `任务执行失败：${reason}`,
      };
      if (message.accountId) {
        failure.accountId = message.accountId;
      }
      if (message.threadId) {
        failure.threadId = message.threadId;
      }
      if (message.messageId) {
        failure.replyToMessageId = message.messageId;
      }
      await channel.sendMessage(failure);
      throw error;
    }
  }

  private resolveAgentId(channelId: ChannelId): AgentId {
    return this.routing.perChannel?.[channelId] ?? this.routing.defaultAgentId;
  }
}
