import { afterEach, describe, expect, test } from "bun:test";
import { TelegramChannelAdapter } from "../../src/channels/telegram";
import {
  TURN_RUNNING_STOP_CALLBACK,
  TURN_RUNNING_QUOTE_CALLBACK,
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_TOKEN,
  buildTurnDecisionCallbackData,
} from "../../src/channels/turn-decision";
import {
  buildTelegramProjectPickCallbackData,
  TELEGRAM_PROJECT_PICK_META_TOKEN,
} from "../../src/channels/telegram-project-picker";
import {
  buildTelegramRenamePickCallbackData,
  TELEGRAM_RENAME_PICK_META_TOKEN,
} from "../../src/channels/telegram-rename-picker";
import {
  buildTelegramDepthCallbackData,
  buildTelegramModelCallbackData,
  buildTelegramSandboxCallbackData,
} from "../../src/channels/telegram-preferences-picker";
import {
  buildTelegramSessionPickCallbackData,
  TELEGRAM_SESSION_PICK_META_TOKEN,
} from "../../src/channels/telegram-session-picker";
import type { ChannelInboundMessage } from "../../src/channels/types";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TelegramChannelAdapter callback query inbound", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forwards turn decision callback_query as inbound decision metadata", async () => {
    const token = "123:abc";
    const callbackId = "cbq-1";
    const decisionToken = "123e4567-e89b-12d3-a456-426614174000";
    const callbackData = buildTurnDecisionCallbackData(decisionToken, "steer");
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 88,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("steer");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/turn-decision");
    expect(inbound.metadata?.[TURN_DECISION_META_ACTION]).toBe("steer");
    expect(inbound.metadata?.[TURN_DECISION_META_TOKEN]).toBe(decisionToken);
  });

  test("maps running-stop callback to /stop inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-stop-1";
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: TURN_RUNNING_STOP_CALLBACK,
                  message: {
                    message_id: 99,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("stop");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/stop");
    expect(inbound.metadata).toBeUndefined();
  });

  test("maps running-quote callback to /running inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-running-quote-1";
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: TURN_RUNNING_QUOTE_CALLBACK,
                  message: {
                    message_id: 100,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("running");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/running");
    expect(inbound.metadata).toBeUndefined();
  });

  test("maps session picker callback to /session-pick inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-session-pick";
    const pickToken = "session-pick-token";
    const callbackData = buildTelegramSessionPickCallbackData(pickToken);
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 111,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("会话");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/session-pick");
    expect(inbound.metadata?.[TELEGRAM_SESSION_PICK_META_TOKEN]).toBe(pickToken);
  });

  test("maps project picker callback to /project-pick inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-project-pick";
    const pickToken = "project-pick-token";
    const callbackData = buildTelegramProjectPickCallbackData(pickToken);
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 112,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("项目");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/project-pick");
    expect(inbound.metadata?.[TELEGRAM_PROJECT_PICK_META_TOKEN]).toBe(pickToken);
  });

  test("maps rename picker callback to /rename-pick inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-rename-pick";
    const pickToken = "rename-pick-token";
    const callbackData = buildTelegramRenamePickCallbackData(pickToken);
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 112,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("会话");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/rename-pick");
    expect(inbound.metadata?.[TELEGRAM_RENAME_PICK_META_TOKEN]).toBe(pickToken);
  });

  test("maps sandbox preference callback to /sandbox inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-sandbox-pref";
    const callbackData = buildTelegramSandboxCallbackData("workspace-write");
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 113,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("sandbox");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/sandbox workspace-write");
    expect(inbound.metadata).toBeUndefined();
  });

  test("maps model preference callback to /model inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-model-pref";
    const callbackData = buildTelegramModelCallbackData("gpt-5.1");
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 114,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("model");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/model gpt-5.1");
    expect(inbound.metadata).toBeUndefined();
  });

  test("maps depth preference callback to /depth inbound command", async () => {
    const token = "123:abc";
    const callbackId = "cbq-depth-pref";
    const callbackData = buildTelegramDepthCallbackData("high");
    let getUpdatesCount = 0;
    let answered = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: callbackId,
                  from: { id: 777, is_bot: false, username: "tester" },
                  data: callbackData,
                  message: {
                    message_id: 115,
                    chat: { id: 10001, type: "private" },
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("depth");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const inbound = await withTimeout(inboundPromise, 2000);
    await adapter.stop();

    expect(answered).toBeTrue();
    expect(inbound.text).toBe("/depth high");
    expect(inbound.metadata).toBeUndefined();
  });

  test("keeps callback responsive even when another outbound request is blocked", async () => {
    const token = "123:abc";
    const callbackId = "cbq-stop-busy";
    let getUpdatesCount = 0;
    let answered = false;

    const firstUpdates = createDeferred<Response>();
    const sendStarted = createDeferred<void>();
    const blockedSend = createDeferred<Response>();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        return jsonResponse({ ok: true, result: true });
      }

      if (url.endsWith(`/bot${token}/sendMessage`)) {
        sendStarted.resolve();
        return await blockedSend.promise;
      }

      if (url.endsWith(`/bot${token}/getUpdates`)) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return await firstUpdates.promise;
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/answerCallbackQuery`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          callback_query_id?: string;
          text?: string;
        };
        expect(body.callback_query_id).toBe(callbackId);
        expect(String(body.text ?? "")).toContain("stop");
        answered = true;
        return jsonResponse({ ok: true, result: true });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    let resolveInbound: ((value: ChannelInboundMessage) => void) | null = null;
    const inboundPromise = new Promise<ChannelInboundMessage>((resolve) => {
      resolveInbound = resolve;
    });

    await adapter.start(async (inbound) => {
      resolveInbound?.(inbound);
    });

    const blockedSendPromise = adapter.sendMessage({
      channelId: "telegram",
      chatId: "10001",
      text: "occupy outbound queue",
    });
    await withTimeout(sendStarted.promise, 1000);

    firstUpdates.resolve(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 1,
            callback_query: {
              id: callbackId,
              from: { id: 777, is_bot: false, username: "tester" },
              data: TURN_RUNNING_STOP_CALLBACK,
              message: {
                message_id: 101,
                chat: { id: 10001, type: "private" },
              },
            },
          },
        ],
      }),
    );

    const inbound = await withTimeout(inboundPromise, 2000);
    expect(inbound.text).toBe("/stop");
    expect(answered).toBeTrue();

    blockedSend.resolve(
      jsonResponse({
        ok: true,
        result: {
          message_id: 6001,
        },
      }),
    );
    await blockedSendPromise;
    await adapter.stop();
  });
});
