import { describe, expect, test } from "bun:test";
import { createDeterministicOrchestrator } from "../support/orchestrator.js";

describe("ChatOrchestrator + Claude Code", () => {
  test("emits prelude status and progress command before final text", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const result = await orchestrator.chat({
      agentId: "claude-code",
      sessionId: "cc-prelude-1",
      input: "帮我检查登录超时的根因。",
    });

    expect(result.events.some((e) => e.type === "status" && e.phase === "thinking")).toBeTrue();
    expect(
      result.events.some(
        (e) =>
          e.type === "command" &&
          "command" in e &&
          typeof (e as { command?: { name?: string } }).command?.name === "string",
      ),
    ).toBeTrue();
    expect(result.finalText.length).toBeGreaterThan(0);
  });

  test("persists memory across turns", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const first = await orchestrator.chat({
      agentId: "claude-code",
      sessionId: "cc-memory-1",
      input: "分析当前支付超时告警。",
    });
    expect(first.finalText.length).toBeGreaterThan(0);

    const second = await orchestrator.chat({
      agentId: "claude-code",
      sessionId: "cc-memory-1",
      input: "基于上次分析，给出下一步修复步骤。",
    });
    expect(second.finalText.length).toBeGreaterThan(0);
    expect(second.events.filter((e) => e.type === "result").length).toBeGreaterThan(0);
  });

  test("respects readability limit on final text", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const result = await orchestrator.chat({
      agentId: "claude-code",
      sessionId: "cc-readability-1",
      input: "列出所有可能的超时场景。",
    });

    expect(result.finalText.length).toBeLessThanOrEqual(800);
  });
});
