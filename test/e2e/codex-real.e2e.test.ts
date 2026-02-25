import { describe, expect, test } from "bun:test";
import { createDefaultOrchestrator } from "../../src/index.js";
import type { ChatOrchestrator } from "../../src/core/orchestrator.js";
import type { OpenCarapaceConfig } from "../../src/config/types.js";

describe("E2E real codex (optional)", () => {
  const TEST_TIMEOUT_MS = 120_000;
  const runner = process.env.E2E_REAL_CODEX === "1" ? test : test.skip;

  function createRealCodexOrchestrator(): ChatOrchestrator {
    const command = process.env.CODEX_CLI_COMMAND?.trim();
    if (!command) {
      throw new Error("E2E_REAL_CODEX=1 but CODEX_CLI_COMMAND is missing");
    }
    const args = (process.env.CODEX_CLI_ARGS ?? "exec {{prompt}}")
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);

    const config: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "codex",
      },
      agents: {
        codex: {
          enabled: true,
          cli_command: command,
          cli_args: args,
        },
        claude_code: {
          enabled: false,
        },
      },
      skills: {
        enable_openclaw_catalog: false,
      },
    };

    return createDefaultOrchestrator({ config });
  }

  runner(
    "returns non-empty output and expected event timeline",
    async () => {
      const orchestrator = createRealCodexOrchestrator();
      const result = await orchestrator.chat({
        agentId: "codex",
        sessionId: "real-codex-e2e-timeline",
        input: "给我一个简短的测试计划，最多 5 条。",
      });

      expect(result.finalText.length).toBeGreaterThan(0);
      expect(result.events.some((event) => event.type === "result")).toBeTrue();
      expect(result.events.some((event) => event.type === "delta")).toBeTrue();
      expect(
        result.events.some(
          (event) =>
            event.type === "command" &&
            (event.command.name === "notify" || event.command.name === "progress"),
        ),
      ).toBeTrue();

      const phases = result.events
        .filter((event): event is Extract<typeof event, { type: "status" }> => event.type === "status")
        .map((event) => event.phase);
      expect(phases).toContain("queued");
      expect(phases).toContain("running");
      expect(phases).toContain("thinking");
      expect(phases).toContain("finalizing");
      expect(phases).toContain("completed");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "keeps final output readable under policy limits",
    async () => {
      const orchestrator = createRealCodexOrchestrator();
      const result = await orchestrator.chat({
        agentId: "codex",
        sessionId: "real-codex-e2e-readable",
        input:
          "请给一份发布计划，包含背景、步骤、风险、回滚、验证、沟通，尽量完整，但最终输出要清晰可读。",
      });

      expect(result.finalText.length).toBeGreaterThan(0);
      expect(result.finalText.length).toBeLessThanOrEqual(800);
      expect(result.finalText.split("\n").length).toBeLessThanOrEqual(12);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "supports multi-turn session continuity with real codex",
    async () => {
      const orchestrator = createRealCodexOrchestrator();

      const first = await orchestrator.chat({
        agentId: "codex",
        sessionId: "real-codex-e2e-session",
        input: "我们要修复登录超时，请先给一个简短方案。",
      });
      expect(first.finalText.length).toBeGreaterThan(0);

      const second = await orchestrator.chat({
        sessionId: "real-codex-e2e-session",
        input: "在你上个方案上，补一个最小验证步骤。",
      });
      expect(second.finalText.length).toBeGreaterThan(0);
      expect(second.agentId).toBe("codex");

      const snapshot = orchestrator.sessions.snapshot("real-codex-e2e-session");
      expect(snapshot?.agentId).toBe("codex");
      expect(snapshot?.messages.length).toBe(4);
      expect(snapshot?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "works with memory command after real codex turns",
    async () => {
      const orchestrator = createRealCodexOrchestrator();

      await orchestrator.chat({
        agentId: "codex",
        sessionId: "real-codex-e2e-memory",
        input: "请给一条关于缓存击穿的简短处理建议。",
      });
      await orchestrator.chat({
        sessionId: "real-codex-e2e-memory",
        input: "补一条对应的监控建议。",
      });

      const memory = await orchestrator.chat({
        sessionId: "real-codex-e2e-memory",
        input: "/memory show 2",
      });
      expect(memory.finalText).toContain("Memory (latest");
      expect(memory.finalText).toContain("user:");
      expect(memory.finalText).toContain("assistant:");
    },
    TEST_TIMEOUT_MS,
  );
});
