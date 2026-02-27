import { afterEach, describe, expect, test } from "bun:test";
import { TelegramChannelAdapter } from "../../src/channels/telegram";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("TelegramChannelAdapter outbound file", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads text attachment through sendDocument", async () => {
    const token = "123:abc";
    let called = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url.endsWith(`/bot${token}/sendDocument`)).toBeTrue();
      expect(init?.method).toBe("POST");
      called = true;

      const form = init?.body;
      expect(form instanceof FormData).toBeTrue();
      if (!(form instanceof FormData)) {
        throw new Error("expected FormData body");
      }
      expect(form.get("chat_id")).toBe("10001");
      expect(form.get("reply_to_message_id")).toBe("42");
      expect(form.get("message_thread_id")).toBe("9");
      expect(form.get("caption")).toBe("完整版回复（文本附件）");
      expect(form.get("document")).toBeTruthy();

      return jsonResponse({
        ok: true,
        result: {
          message_id: 88,
        },
      });
    }) as typeof fetch;

    const adapter = new TelegramChannelAdapter({
      token,
      pollTimeoutSeconds: 1,
      retryDelayMs: 200,
    });

    const receipt = await adapter.sendFile({
      channelId: "telegram",
      chatId: "10001",
      replyToMessageId: "42",
      threadId: "9",
      fileName: "full.txt",
      content: "完整文本内容",
      mimeType: "text/plain; charset=utf-8",
      caption: "完整版回复（文本附件）",
    });

    expect(called).toBeTrue();
    expect(receipt.messageId).toBe("88");
  });
});
