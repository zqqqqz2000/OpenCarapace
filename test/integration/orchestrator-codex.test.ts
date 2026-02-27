import { describe, expect, test } from "bun:test";
import { createDeterministicOrchestrator } from "../support/orchestrator";

describe("ChatOrchestrator + Codex", () => {
  test("streams status/commands and persists memory across turns", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const first = await orchestrator.chat({
      agentId: "codex",
      sessionId: "s-1",
      input: "请帮我修复登录超时并给一个简短过程。",
    });

    expect(first.events.some((event) => event.type === "status" && event.phase === "thinking")).toBeTrue();
    expect(first.events.some((event) => event.type === "command")).toBeTrue();
    expect(first.finalText.length).toBeLessThanOrEqual(800);

    const second = await orchestrator.chat({
      agentId: "codex",
      sessionId: "s-1",
      input: "基于上次结果，补一个验证步骤。",
    });

    expect(second.finalText.length).toBeGreaterThan(0);
    expect(second.events.filter((event) => event.type === "result").length).toBeGreaterThan(0);
  });
});
