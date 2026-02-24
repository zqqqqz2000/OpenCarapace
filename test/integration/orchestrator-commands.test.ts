import { describe, expect, test } from "bun:test";
import { createDeterministicOrchestrator } from "../support/orchestrator.js";

describe("ChatOrchestrator commands", () => {
  test("handles slash commands without requiring agentId", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const result = await orchestrator.chat({
      sessionId: "cmd-help-1",
      input: "/help",
    });

    expect(result.agentId).toBe("codex");
    expect(result.finalText).toContain("/status");
    expect(result.events.some((event) => event.type === "result")).toBeTrue();
    expect(orchestrator.sessions.snapshot("cmd-help-1")).toBeUndefined();
  });

  test("switches agent via /agent and uses session-bound agent for next turn", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const switched = await orchestrator.chat({
      sessionId: "cmd-agent-1",
      input: "/agent cloudcode",
    });
    expect(switched.agentId).toBe("cloudcode");
    expect(switched.finalText).toContain("Agent switched");

    const status = await orchestrator.chat({
      sessionId: "cmd-agent-1",
      input: "/status",
    });
    expect(status.agentId).toBe("cloudcode");
    expect(status.finalText).toContain("- agent: cloudcode");

    const turn = await orchestrator.chat({
      sessionId: "cmd-agent-1",
      input: "请给我一句执行状态。",
    });
    expect(turn.agentId).toBe("cloudcode");
    expect(turn.finalText).toContain("CloudCode adapter is wired");

    const session = orchestrator.sessions.snapshot("cmd-agent-1");
    expect(session?.agentId).toBe("cloudcode");
    expect(session?.messages.length).toBe(2);
  });

  test("supports /memory show and /memory clear", async () => {
    const orchestrator = createDeterministicOrchestrator();

    await orchestrator.chat({
      agentId: "codex",
      sessionId: "cmd-memory-1",
      input: "请给我一个关于登录超时的简短建议。",
    });

    const shown = await orchestrator.chat({
      sessionId: "cmd-memory-1",
      input: "/memory show 1",
    });
    expect(shown.finalText).toContain("Memory (latest 1)");

    const cleared = await orchestrator.chat({
      sessionId: "cmd-memory-1",
      input: "/memory clear",
    });
    expect(cleared.finalText).toContain("Memory cleared");

    const empty = await orchestrator.chat({
      sessionId: "cmd-memory-1",
      input: "/memory show 1",
    });
    expect(empty.finalText).toContain("Memory is empty");
  });
});
