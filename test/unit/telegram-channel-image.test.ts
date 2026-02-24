import fs from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { TelegramChannelAdapter } from "../../src/channels/telegram.js";
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

describe("TelegramChannelAdapter media inbound", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("downloads inbound photo into temp path and forwards local attachment/image paths", async () => {
    const token = "123:abc";
    let getUpdatesCount = 0;
    let sawSetMyCommands = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/bot${token}/setMyCommands`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          commands?: Array<{ command?: string }>;
        };
        const commands = (body.commands ?? []).map((entry) => entry.command);
        expect(commands).toContain("help");
        expect(commands).toContain("command");
        expect(commands).toContain("sandbox");
        sawSetMyCommands = true;
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
                message: {
                  message_id: 42,
                  caption: "这图片什么内容",
                  chat: { id: 10001, type: "private" },
                  from: { id: 777, is_bot: false, username: "tester" },
                  photo: [
                    {
                      file_id: "small-file",
                      file_unique_id: "small-unique",
                      width: 90,
                      height: 90,
                      file_size: 1200,
                    },
                    {
                      file_id: "large-file",
                      file_unique_id: "large-unique",
                      width: 512,
                      height: 512,
                      file_size: 8000,
                    },
                  ],
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/getFile`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { file_id?: string };
        expect(body.file_id).toBe("large-file");
        return jsonResponse({
          ok: true,
          result: {
            file_id: "large-file",
            file_unique_id: "large-unique",
            file_path: "photos/large-file.jpg",
          },
        });
      }

      if (url.endsWith(`/file/bot${token}/photos/large-file.jpg`)) {
        return new Response("fake-image-bytes", {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
          },
        });
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

    expect(sawSetMyCommands).toBeTrue();
    expect(inbound.text).toBe("这图片什么内容");
    expect(inbound.attachmentPaths?.length).toBe(1);
    expect(inbound.imagePaths?.length).toBe(1);

    const localPath = inbound.attachmentPaths?.[0] ?? inbound.imagePaths?.[0];
    expect(typeof localPath).toBe("string");
    if (!localPath) {
      throw new Error("image path missing");
    }

    expect(fs.existsSync(localPath)).toBeTrue();
    expect(fs.readFileSync(localPath, "utf-8")).toBe("fake-image-bytes");
    fs.rmSync(localPath, { force: true });
  });

  test("downloads inbound voice into temp path and forwards local attachment path", async () => {
    const token = "123:abc";
    let getUpdatesCount = 0;

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
                message: {
                  message_id: 48,
                  chat: { id: 10001, type: "private" },
                  from: { id: 777, is_bot: false, username: "tester" },
                  voice: {
                    file_id: "voice-file",
                    file_unique_id: "voice-unique",
                    file_size: 2048,
                  },
                },
              },
            ],
          });
        }
        return jsonResponse({ ok: true, result: [] });
      }

      if (url.endsWith(`/bot${token}/getFile`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { file_id?: string };
        expect(body.file_id).toBe("voice-file");
        return jsonResponse({
          ok: true,
          result: {
            file_id: "voice-file",
            file_unique_id: "voice-unique",
            file_path: "voice/file_123.ogg",
          },
        });
      }

      if (url.endsWith(`/file/bot${token}/voice/file_123.ogg`)) {
        return new Response("fake-voice-bytes", {
          status: 200,
          headers: {
            "content-type": "audio/ogg",
          },
        });
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

    expect(inbound.text).toBe("请基于附带附件进行处理。");
    expect(inbound.attachmentPaths?.length).toBe(1);
    expect(inbound.imagePaths).toBeUndefined();

    const localPath = inbound.attachmentPaths?.[0];
    expect(typeof localPath).toBe("string");
    if (!localPath) {
      throw new Error("attachment path missing");
    }

    expect(fs.existsSync(localPath)).toBeTrue();
    expect(fs.readFileSync(localPath, "utf-8")).toBe("fake-voice-bytes");
    fs.rmSync(localPath, { force: true });
  });
});
