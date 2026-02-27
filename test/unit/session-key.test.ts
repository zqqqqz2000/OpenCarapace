import { describe, expect, test } from "bun:test";
import {
  buildChannelSessionId,
  decodeChannelSessionProjectKey,
  parseChannelSessionId,
} from "../../src/channels/session-key";

describe("channel session key", () => {
  test("round-trips project names containing dots", () => {
    const sessionId = buildChannelSessionId(
      {
        channelId: "telegram",
        chatId: "chat-main",
        threadId: "thread-main",
      },
      { projectKey: "proj.alpha.v1" },
    );

    expect(sessionId).toContain("proj%2Ealpha%2Ev1");
    const parsed = parseChannelSessionId(sessionId);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed session id");
    }
    expect(parsed.projectKey).toBe("proj%2Ealpha%2Ev1");
    expect(decodeChannelSessionProjectKey(parsed.projectKey)).toBe("proj.alpha.v1");
    expect(parsed.conversationKey).toBe("telegram.chat-main.thread-main");
  });

  test("keeps project key normalization idempotent for encoded inputs", () => {
    const message = {
      channelId: "telegram",
      chatId: "chat-main",
      threadId: "thread-main",
    } as const;
    const first = buildChannelSessionId(message, { projectKey: "proj alpha" });
    const parsed = parseChannelSessionId(first);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed session id");
    }

    const second = buildChannelSessionId(message, { projectKey: parsed.projectKey });
    expect(second).toBe(first);
  });
});
