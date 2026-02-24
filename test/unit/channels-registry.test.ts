import { describe, expect, test } from "bun:test";
import { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelAdapter } from "../../src/channels/types.js";

function adapter(id: string): ChannelAdapter {
  return {
    id,
    displayName: id,
    capabilities: {
      supportsMessageEdit: false,
      maxMessageChars: 3000,
      supportsThreads: false,
    },
    async sendMessage() {
      return {};
    },
  };
}

describe("ChannelRegistry", () => {
  test("registers and resolves channels", () => {
    const registry = new ChannelRegistry();
    registry.register(adapter("telegram"));
    registry.register(adapter("slack"));

    expect(registry.get("telegram")?.displayName).toBe("telegram");
    expect(registry.list().length).toBe(2);
  });

  test("rejects invalid and duplicate ids", () => {
    const registry = new ChannelRegistry();
    expect(() => registry.register(adapter("Invalid"))).toThrow(/invalid channel id/i);

    registry.register(adapter("telegram"));
    expect(() => registry.register(adapter("telegram"))).toThrow(/duplicate channel adapter/i);
  });
});
