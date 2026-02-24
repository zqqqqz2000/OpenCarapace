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
    expect(turn.finalText).toContain("CloudCode deterministic test backend response.");

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

  test("supports /tools and /grep commands", async () => {
    const orchestrator = createDeterministicOrchestrator();

    const tools = await orchestrator.chat({
      sessionId: "cmd-tools-1",
      input: "/tools",
    });
    expect(tools.finalText).toContain("Tools");
    expect(tools.finalText).toContain("grep");

    const grep = await orchestrator.chat({
      sessionId: "cmd-tools-1",
      input: "/grep open-carapace --path package.json --limit 2",
    });
    expect(grep.finalText).toContain("Grep matches");
    expect(grep.finalText).toContain("package.json");
  });

  test("shows readable session name and short relative updated time in /sessions", async () => {
    const orchestrator = createDeterministicOrchestrator();

    await orchestrator.chat({
      sessionId: "cmd-sessions-name",
      input: "帮我梳理支付超时与重试告警的排查步骤",
    });

    const sessions = await orchestrator.chat({
      sessionId: "cmd-sessions-name",
      input: "/sessions",
    });
    expect(sessions.finalText).toContain("Sessions (1)");
    expect(sessions.finalText).toContain("帮我梳理支付超时与重试告警的排查步骤");
    expect(sessions.finalText).toMatch(/updated=(now|\d+m|\d+h|\d+d|\d+w|\d+mo|\d+y)/);
  });
});
