import { describe, expect, test } from "bun:test";
import { createDeterministicOrchestrator } from "../support/orchestrator";

describe("E2E chat with Codex adapter", () => {
  test("provides in-flight hints, concise process, readable final output", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const result = await orchestrator.chat({
      agentId: "codex",
      sessionId: "e2e-codex-1",
      input: "帮我做一个小功能发布任务：需要简单过程提示和最终简短结果。",
    });

    const progressEvents = result.events.filter(
      (event) => event.type === "command" && (event.command.name === "progress" || event.command.name === "notify"),
    );

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(result.finalText.length).toBeLessThanOrEqual(800);
    expect(result.finalText.split("\n").length).toBeLessThanOrEqual(12);
    expect(result.finalText).toContain("结果");
    expect(result.finalText).toContain("过程");
  });
});
