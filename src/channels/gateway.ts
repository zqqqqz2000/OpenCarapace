import { randomUUID } from "node:crypto";
import { ChatOrchestrator } from "../core/orchestrator.js";
import { isTurnAbortedError } from "../core/abort.js";
import type { AgentEvent, AgentId, ChatTurnResult } from "../core/types.js";
import { ChannelRegistry } from "./registry.js";
import { buildChannelSessionId } from "./session-key.js";
import type { TurnDecisionAction } from "./turn-decision.js";
import {
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_BYPASS,
  TURN_DECISION_META_FORCE_STEER,
  TURN_DECISION_META_TOKEN,
  TURN_RUNNING_STOP_CALLBACK,
  buildTurnDecisionCallbackData,
} from "./turn-decision.js";
import type {
  ChannelAdapter,
  ChannelAgentRouting,
  ChannelEditMessage,
  ChannelFileAttachment,
  ChannelId,
  ChannelInboundHandler,
  ChannelInboundMessage,
  ChannelOutboundMessage,
} from "./types.js";

const DEFAULT_PROGRESS_THROTTLE_MS = 1200;
const DEFAULT_DELTA_PREVIEW_MAX_CHARS = 180;
const RUNNING_ANIMATION_INTERVAL_MS = 500;
const RUNNING_ANIMATION_FRAMES = [
  "🌑",
  "🌒",
  "🌓",
  "🌔",
  "🌕",
  "🌖",
  "🌗",
  "🌘",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function clipTextFromTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(Math.max(0, text.length - maxChars));
  }
  return `…${text.slice(text.length - (maxChars - 1))}`;
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

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

function resolveCommandText(
  event: Extract<AgentEvent, { type: "command" }>,
): string | undefined {
  const payloadText = event.command.payload.text;
  if (typeof payloadText === "string") {
    return payloadText.trim();
  }
  return undefined;
}

function looksLikeSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return /^\/\S+/.test(trimmed);
}

function cloneMetadata(metadata: unknown): Record<string, unknown> {
  if (!isRecord(metadata)) {
    return {};
  }
  return {
    ...metadata,
  };
}

function readTurnDecisionSelection(
  metadata: unknown,
): { action: TurnDecisionAction; token: string } | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const action = metadata[TURN_DECISION_META_ACTION];
  const token = metadata[TURN_DECISION_META_TOKEN];
  if (
    (action === "steer" || action === "stack") &&
    typeof token === "string" &&
    token.trim()
  ) {
    return {
      action,
      token: token.trim(),
    };
  }
  return null;
}

function shouldBypassTurnDecision(metadata: unknown): boolean {
  return isRecord(metadata) && metadata[TURN_DECISION_META_BYPASS] === true;
}

function shouldForceSteer(metadata: unknown): boolean {
  return (
    isRecord(metadata) && metadata[TURN_DECISION_META_FORCE_STEER] === true
  );
}

type TurnRelayOptions = {
  progressThrottleMs?: number;
  deltaPreviewMaxChars?: number;
};

type PendingTurnDecision = {
  token: string;
  inbound: ChannelInboundMessage;
  createdAt: number;
};

type StackedQueueEntry = {
  id: string;
  preview: string;
};

class ChannelTurnRelay {
  private progressMessageId: string | undefined;
  private readonly seenStatus = new Set<string>();
  private deltaBuffer = "";
  private lastProgressAt = 0;
  private lastProgressText = "";
  private lastRenderedProgress = "";
  private animationFrameIndex = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private animationEditing = false;
  private progressChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly animationEnabled: boolean;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly inbound: ChannelInboundMessage,
    private readonly options: TurnRelayOptions = {},
  ) {
    this.animationEnabled = !looksLikeSlashCommand(inbound.text);
  }

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "status":
        this.enqueueProgressWork(async () => {
          await this.handleStatus(event);
        });
        return;
      case "command":
        this.enqueueProgressWork(async () => {
          await this.handleCommand(event);
        });
        return;
      case "delta":
        this.enqueueProgressWork(async () => {
          await this.handleDelta(event.text);
        });
        return;
      case "error":
        this.enqueueProgressWork(async () => {
          await this.sendProgress(`任务执行出错：${event.error}`);
        });
        return;
      case "result":
        return;
      default:
        return;
    }
  }

  async finalize(result: ChatTurnResult): Promise<void> {
    this.stopProgressAnimation();
    this.closed = true;
    await this.flushDeltaPreview(true);

    const maxChars = Math.max(300, this.adapter.capabilities.maxMessageChars);
    const fullText =
      typeof result.rawFinalText === "string"
        ? result.rawFinalText.replace(/\r/g, "").trim()
        : "";
    if (this.adapter.sendFile && fullText) {
      if (fullText.length <= maxChars) {
        await this.sendText(fullText);
        return;
      }
      await this.sendText(clipTextFromTop(fullText, maxChars));
      await this.sendFullTextAttachment(fullText);
      return;
    }

    const chunks = splitOutboundText(result.finalText, maxChars);
    if (chunks.length === 0) {
      await this.sendText("暂无可读结果，请重试。");
      return;
    }

    for (const chunk of chunks) {
      await this.sendText(chunk);
    }
  }

  dispose(): void {
    this.closed = true;
    this.stopProgressAnimation();
  }

  private enqueueProgressWork(work: () => Promise<void>): void {
    if (this.closed) {
      return;
    }
    const run = async () => {
      if (this.closed) {
        return;
      }
      await work();
    };
    this.progressChain = this.progressChain.then(run, run).catch(() => {
      // Keep progress pipeline resilient on transport failures.
    });
  }

  private async sendFullTextAttachment(fullText: string): Promise<void> {
    if (!this.adapter.sendFile) {
      return;
    }
    const attachment: ChannelFileAttachment = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      fileName: `opencarapace-full-response-${Date.now()}.txt`,
      content: fullText,
      mimeType: "text/plain; charset=utf-8",
      caption: "完整版回复（文本附件）",
    };
    if (this.inbound.accountId) {
      attachment.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      attachment.threadId = this.inbound.threadId;
    }
    if (this.inbound.messageId) {
      attachment.replyToMessageId = this.inbound.messageId;
    }
    await this.adapter.sendFile(attachment);
  }

  private async handleStatus(
    event: Extract<AgentEvent, { type: "status" }>,
  ): Promise<void> {
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

  private async handleCommand(
    event: Extract<AgentEvent, { type: "command" }>,
  ): Promise<void> {
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

    const throttleMs =
      this.options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < throttleMs) {
      return;
    }

    const maxChars =
      this.options.deltaPreviewMaxChars ?? DEFAULT_DELTA_PREVIEW_MAX_CHARS;
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
    this.lastProgressText = normalized;
    const rendered = this.renderProgressText(normalized);

    if (
      this.animationEnabled &&
      this.adapter.capabilities.supportsMessageEdit &&
      this.progressMessageId &&
      this.adapter.editMessage
    ) {
      await this.editProgressMessage(rendered);
      this.startProgressAnimation();
      return;
    }

    const sent = await this.sendText(rendered, this.runningControlMetadata());
    this.lastRenderedProgress = rendered;
    if (this.adapter.capabilities.supportsMessageEdit && sent.messageId) {
      this.progressMessageId = sent.messageId;
      this.startProgressAnimation();
    }
  }

  private renderProgressText(text: string): string {
    const frame =
      RUNNING_ANIMATION_FRAMES[
        this.animationFrameIndex % RUNNING_ANIMATION_FRAMES.length
      ] ?? "🌑";
    return `${frame} ${text}`;
  }

  private startProgressAnimation(): void {
    if (!this.animationEnabled) {
      return;
    }
    if (
      !this.adapter.capabilities.supportsMessageEdit ||
      !this.adapter.editMessage ||
      !this.progressMessageId
    ) {
      return;
    }
    if (this.animationTimer) {
      return;
    }
    this.animationTimer = setInterval(() => {
      void this.tickProgressAnimation();
    }, RUNNING_ANIMATION_INTERVAL_MS);
  }

  private stopProgressAnimation(): void {
    if (!this.animationTimer) {
      return;
    }
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
    this.animationEditing = false;
  }

  private async tickProgressAnimation(): Promise<void> {
    if (
      !this.lastProgressText ||
      !this.progressMessageId ||
      !this.adapter.editMessage
    ) {
      return;
    }
    if (this.animationEditing) {
      return;
    }
    this.animationEditing = true;
    try {
      this.animationFrameIndex =
        (this.animationFrameIndex + 1) % RUNNING_ANIMATION_FRAMES.length;
      await this.editProgressMessage(
        this.renderProgressText(this.lastProgressText),
      );
    } finally {
      this.animationEditing = false;
    }
  }

  private async editProgressMessage(text: string): Promise<void> {
    if (!this.progressMessageId || !this.adapter.editMessage) {
      return;
    }
    if (text === this.lastRenderedProgress) {
      return;
    }
    const edit: ChannelEditMessage = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      messageId: this.progressMessageId,
      text,
    };
    if (this.inbound.accountId) {
      edit.accountId = this.inbound.accountId;
    }
    if (this.inbound.threadId) {
      edit.threadId = this.inbound.threadId;
    }
    const metadata = this.runningControlMetadata();
    if (metadata) {
      edit.metadata = metadata;
    }
    await this.adapter.editMessage(edit);
    this.lastRenderedProgress = text;
  }

  private runningControlMetadata(): Record<string, unknown> | undefined {
    if (!this.animationEnabled) {
      return undefined;
    }
    if (this.adapter.id !== "telegram") {
      return undefined;
    }
    return {
      telegram_reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛑 Stop",
              callback_data: TURN_RUNNING_STOP_CALLBACK,
            },
          ],
        ],
      },
    };
  }

  private async sendText(
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
    const outbound: ChannelOutboundMessage = {
      channelId: this.adapter.id,
      chatId: this.inbound.chatId,
      text,
    };
    if (metadata) {
      outbound.metadata = metadata;
    }
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
  private readonly pendingTurnDecisions = new Map<
    string,
    PendingTurnDecision
  >();
  private readonly stackedTurnQueues = new Map<string, StackedQueueEntry[]>();

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
    const turnDecision = readTurnDecisionSelection(message.metadata);
    if (turnDecision) {
      return await this.handleTurnDecisionSelection({
        channel,
        message,
        sessionId,
        agentId,
        selection: turnDecision,
      });
    }

    if (
      this.pendingTurnDecisions.has(sessionId) &&
      !this.orchestrator.isTurnRunning(sessionId)
    ) {
      this.pendingTurnDecisions.delete(sessionId);
    }

    const bypassTurnDecision = shouldBypassTurnDecision(message.metadata);
    const isCommandMessage = looksLikeSlashCommand(message.text);
    if (
      !isCommandMessage &&
      this.orchestrator.isTurnRunning(sessionId) &&
      !bypassTurnDecision
    ) {
      await this.promptTurnDecision(channel, message, sessionId);
      return this.emptyTurnResult(agentId, sessionId);
    }

    const relay = new ChannelTurnRelay(channel, message);
    const steerTriggered =
      !isCommandMessage &&
      shouldForceSteer(message.metadata) &&
      this.orchestrator.cancelRunningTurn(
        sessionId,
        `Steered by newer message ${message.messageId ?? "(no-message-id)"}`,
      );

    try {
      const normalizedMetadata = cloneMetadata(message.metadata);
      delete normalizedMetadata[TURN_DECISION_META_ACTION];
      delete normalizedMetadata[TURN_DECISION_META_TOKEN];
      delete normalizedMetadata[TURN_DECISION_META_BYPASS];
      delete normalizedMetadata[TURN_DECISION_META_FORCE_STEER];

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
          attachmentPaths: message.attachmentPaths,
          imagePaths: message.imagePaths,
          rawInbound: message.raw,
          steer: steerTriggered,
          ...normalizedMetadata,
        },
        onEvent: async (event) => {
          await relay.onEvent(event);
        },
      });

      await relay.finalize(result);
      return result;
    } catch (error) {
      if (isTurnAbortedError(error)) {
        return this.emptyTurnResult(agentId, sessionId);
      }

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
    } finally {
      relay.dispose();
    }
  }

  private async handleTurnDecisionSelection(params: {
    channel: ChannelAdapter;
    message: ChannelInboundMessage;
    sessionId: string;
    agentId: AgentId;
    selection: {
      action: TurnDecisionAction;
      token: string;
    };
  }): Promise<ChatTurnResult> {
    const pending = this.pendingTurnDecisions.get(params.sessionId);
    if (!pending) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "当前没有待决策的新消息，请直接发送新消息。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    if (pending.token !== params.selection.token) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "这个选项已过期，请按最新提示选择。",
      );
      return this.emptyTurnResult(params.agentId, params.sessionId);
    }

    this.pendingTurnDecisions.delete(params.sessionId);
    const forceSteer = params.selection.action === "steer";
    const replayMetadata = cloneMetadata(pending.inbound.metadata);
    replayMetadata[TURN_DECISION_META_BYPASS] = true;
    replayMetadata[TURN_DECISION_META_FORCE_STEER] = forceSteer;
    const replay: ChannelInboundMessage = {
      ...pending.inbound,
      metadata: replayMetadata,
    };
    if (forceSteer) {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        "已选择 1. steer：正在中断当前任务并切换到新消息。",
      );
      return await this.handleInbound(replay);
    }

    const queued = this.enqueueStackedTurn(params.sessionId, pending.inbound.text);
    try {
      await this.sendAuxiliaryMessage(
        params.channel,
        params.message,
        this.formatStackQueueMessage(queued.snapshot),
      );
      return await this.handleInbound(replay);
    } finally {
      this.dequeueStackedTurn(params.sessionId, queued.entryId);
    }
  }

  private async promptTurnDecision(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    sessionId: string,
  ): Promise<void> {
    const token = randomUUID();
    this.pendingTurnDecisions.set(sessionId, {
      token,
      inbound,
      createdAt: Date.now(),
    });

    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text: [
        "<b>检测到你发送了新消息</b>",
        "当前任务仍在运行，请选择处理方式：",
        "1. <b>steer</b>：中断当前任务并切换到新消息",
        "2. <b>stack</b>：保持当前任务，新消息进入队列",
      ].join("\n"),
      metadata: {
        telegram_parse_mode: "HTML",
        telegram_reply_markup: {
          inline_keyboard: [
            [
              {
                text: "1. Steer",
                callback_data: buildTurnDecisionCallbackData(token, "steer"),
              },
              {
                text: "2. Stack",
                callback_data: buildTurnDecisionCallbackData(token, "stack"),
              },
            ],
          ],
        },
      },
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private async sendAuxiliaryMessage(
    channel: ChannelAdapter,
    inbound: ChannelInboundMessage,
    text: string,
  ): Promise<void> {
    const outbound: ChannelOutboundMessage = {
      channelId: channel.id,
      chatId: inbound.chatId,
      text,
    };
    if (inbound.accountId) {
      outbound.accountId = inbound.accountId;
    }
    if (inbound.threadId) {
      outbound.threadId = inbound.threadId;
    }
    if (inbound.messageId) {
      outbound.replyToMessageId = inbound.messageId;
    }
    await channel.sendMessage(outbound);
  }

  private enqueueStackedTurn(
    sessionId: string,
    text: string,
  ): { entryId: string; snapshot: string[] } {
    const queue = this.stackedTurnQueues.get(sessionId) ?? [];
    const entry: StackedQueueEntry = {
      id: randomUUID(),
      preview: clipText(compactWhitespace(text), 80),
    };
    queue.push(entry);
    this.stackedTurnQueues.set(sessionId, queue);
    return {
      entryId: entry.id,
      snapshot: queue.map((item) => item.preview),
    };
  }

  private dequeueStackedTurn(sessionId: string, entryId: string): void {
    const queue = this.stackedTurnQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }
    const next = queue.filter((item) => item.id !== entryId);
    if (next.length === 0) {
      this.stackedTurnQueues.delete(sessionId);
      return;
    }
    this.stackedTurnQueues.set(sessionId, next);
  }

  private formatStackQueueMessage(queuePreviews: string[]): string {
    const rows = queuePreviews.map((item, index) => `${index + 1}. ${item}`);
    return [
      "已选择 2. stack：新消息已进入队列。",
      "当前队列（按顺序）：",
      ...rows,
    ].join("\n");
  }

  private emptyTurnResult(agentId: AgentId, sessionId: string): ChatTurnResult {
    return {
      agentId,
      sessionId,
      finalText: "",
      rawFinalText: "",
      events: [],
    };
  }

  private resolveAgentId(channelId: ChannelId): AgentId {
    return this.routing.perChannel?.[channelId] ?? this.routing.defaultAgentId;
  }
}
