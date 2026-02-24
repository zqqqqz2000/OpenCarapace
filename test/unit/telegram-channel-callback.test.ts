import { afterEach, describe, expect, test } from "bun:test";
import { TelegramChannelAdapter } from "../../src/channels/telegram.js";
import {
  TURN_DECISION_META_ACTION,
  TURN_DECISION_META_TOKEN,
  buildTurnDecisionCallbackData,
} from "../../src/channels/turn-decision.js";
import type { ChannelInboundMessage } from "../../src/channels/types.js";

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
});
