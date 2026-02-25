import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ConversationCommandService, parseSlashCommand } from "../../src/core/commands.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { SessionManager, InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime, InstructionSkill } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { CodexAgentAdapter } from "../../src/adapters/codex.js";
import { CloudCodeAgentAdapter } from "../../src/adapters/cloudcode.js";
import { OpenClawCatalogSkill } from "../../src/integrations/openclaw-skills.js";
import { createGrepWorkspaceTool } from "../../src/tools/grep-tool.js";
import { createSkillLookupTool } from "../../src/tools/skill-tool.js";

function createServiceBundle(options?: {
  isSessionRunning?: (sessionId: string) => boolean;
  cancelSessionTurn?: (sessionId: string, reason?: string) => boolean;
}): {
  service: ConversationCommandService;
  sessions: SessionManager;
} {
  const registry = new AgentRegistry();
  registry.register(new CodexAgentAdapter());
  registry.register(new CloudCodeAgentAdapter());

  const skills = new SkillRuntime();
  skills.register(
    new InstructionSkill({
      id: "codex.readable.final",
      description: "readable final",
      instruction: "keep final concise",
      appliesTo: ["codex"],
    }),
  );
  skills.register(
    new OpenClawCatalogSkill([
      {
        id: "deploy-checklist",
        name: "Deploy Checklist",
        filePath: "/tmp/deploy/SKILL.md",
        summary: "Safe deployment with rollback and validation",
        content: "Ensure rollback steps are prepared.",
      },
    ]),
  );

  const tools = new ToolRuntime();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-cmd-test-"));
  const sourceFile = path.join(tmpDir, "sample.txt");
  writeFileSync(sourceFile, "deploy-safe-token\nroll back plan\n", "utf-8");
  tools.register(
    createGrepWorkspaceTool({
      defaultRootDir: tmpDir,
    }),
  );
  tools.register(
    createSkillLookupTool({
      docsProvider: () => {
        const openclaw = skills
          .listAll()
          .find((skill): skill is OpenClawCatalogSkill => skill instanceof OpenClawCatalogSkill);
        return openclaw?.listDocs() ?? [];
      },
    }),
  );

  const sessions = new SessionManager(new InMemorySessionStore());
  const deps = {
    registry,
    sessions,
    skills,
    tools,
  } as {
    registry: AgentRegistry;
    sessions: SessionManager;
    skills: SkillRuntime;
    tools: ToolRuntime;
    isSessionRunning?: (sessionId: string) => boolean;
    cancelSessionTurn?: (sessionId: string, reason?: string) => boolean;
  };
  if (options?.isSessionRunning) {
    deps.isSessionRunning = options.isSessionRunning;
  }
  if (options?.cancelSessionTurn) {
    deps.cancelSessionTurn = options.cancelSessionTurn;
  }
  const service = new ConversationCommandService(deps);
  return { service, sessions };
}

function createService(): ConversationCommandService {
  return createServiceBundle().service;
}

describe("parseSlashCommand", () => {
  test("parses command name and args", () => {
    expect(parseSlashCommand("/memory show 3")).toEqual({
      name: "memory",
      args: ["show", "3"],
      raw: "/memory show 3",
    });
  });

  test("handles quoted args", () => {
    const parsed = parseSlashCommand("/agent \"cloudcode\"");
    expect(parsed?.name).toBe("agent");
    expect(parsed?.args).toEqual(["cloudcode"]);
  });

  test("returns null for non command input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });

  test("normalizes telegram command mention suffix", () => {
    expect(parseSlashCommand("/status@OpenCarapaceBot")?.name).toBe("status");
  });
});

describe("ConversationCommandService", () => {
  test("returns help from /command list", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/command list",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("/status");
  });

  test("switches agent on /agent command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/agent cloudcode",
    });

    expect(result.handled).toBeTrue();
    expect(result.agentId).toBe("cloudcode");
    expect(result.finalText).toContain("Agent switched");
  });

  test("lists openclaw catalog by /skills catalog", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/skills catalog 5",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("OpenClaw skills");
    expect(result.finalText).toContain("Deploy Checklist");
  });

  test("runs grep tool by /grep command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/grep deploy-safe-token --path sample.txt --limit 3",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Grep matches");
    expect(result.finalText).toContain("deploy-safe-token");
  });

  test("runs skill lookup by /skill command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/skill deploy rollback",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Skill matches");
    expect(result.finalText).toContain("Deploy Checklist");
  });

  test("sets and clears model preference by /model", () => {
    const service = createService();

    const setResult = service.execute({
      sessionId: "s-model",
      currentAgentId: "codex",
      input: "/model gpt-5",
    });
    expect(setResult.handled).toBeTrue();
    expect(setResult.finalText).toContain("Model preference set.");

    const showResult = service.execute({
      sessionId: "s-model",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(showResult.finalText).toContain("- model: gpt-5");

    const clearResult = service.execute({
      sessionId: "s-model",
      currentAgentId: "codex",
      input: "/model clear",
    });
    expect(clearResult.finalText).toContain("Model preference cleared");
  });

  test("sets thinking depth by /depth", () => {
    const service = createService();
    const setResult = service.execute({
      sessionId: "s-depth",
      currentAgentId: "codex",
      input: "/depth high",
    });

    expect(setResult.handled).toBeTrue();
    expect(setResult.finalText).toContain("depth: high");

    const status = service.execute({
      sessionId: "s-depth",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(status.finalText).toContain("- thinkingDepth: high");
  });

  test("sets and clears codex sandbox mode by /sandbox", () => {
    const service = createService();
    const setResult = service.execute({
      sessionId: "s-sandbox",
      currentAgentId: "codex",
      input: "/sandbox isolated",
    });
    expect(setResult.handled).toBeTrue();
    expect(setResult.finalText).toContain("- sandbox: read-only");

    const status = service.execute({
      sessionId: "s-sandbox",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(status.finalText).toContain("- sandbox: read-only");

    const clearResult = service.execute({
      sessionId: "s-sandbox",
      currentAgentId: "codex",
      input: "/sandbox clear",
    });
    expect(clearResult.handled).toBeTrue();
    expect(clearResult.finalText).toContain("Sandbox mode cleared");
  });

  test("shows codex context usage in /status when usage is available", () => {
    const { service, sessions } = createServiceBundle();
    sessions.setMetadata("s-usage", "codex", {
      codex_usage_snapshot: {
        context_used_tokens: 1200,
        context_window_tokens: 4000,
      },
    });

    const status = service.execute({
      sessionId: "s-usage",
      currentAgentId: "codex",
      input: "/status",
    });

    expect(status.handled).toBeTrue();
    expect(status.finalText).toContain("- codexContextUsage: 30% (1200/4000)");
  });

  test("shows fallback usage text when codex returns token totals only", () => {
    const { service, sessions } = createServiceBundle();
    sessions.setMetadata("s-usage-fallback", "codex", {
      codex_usage_snapshot: {
        input_tokens: 76561,
        cached_input_tokens: 67456,
        output_tokens: 2760,
      },
    });

    const status = service.execute({
      sessionId: "s-usage-fallback",
      currentAgentId: "codex",
      input: "/status",
    });

    expect(status.handled).toBeTrue();
    expect(status.finalText).toContain("- codexContextUsage: 76561 used (limit unknown)");
  });

  test("stops running turn by /stop", () => {
    let cancelCalls = 0;
    const service = createServiceBundle({
      cancelSessionTurn: () => {
        cancelCalls += 1;
        return true;
      },
    }).service;
    const result = service.execute({
      sessionId: "s-stop",
      currentAgentId: "codex",
      input: "/stop",
    });
    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Stop signal sent.");
    expect(cancelCalls).toBe(1);
  });

  test("returns no-running message when /stop cannot cancel", () => {
    const service = createServiceBundle({
      cancelSessionTurn: () => false,
    }).service;
    const result = service.execute({
      sessionId: "s-stop-empty",
      currentAgentId: "codex",
      input: "/stop",
    });
    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("No running turn to stop");
  });

  test("formats /sessions with readable name and short relative time", () => {
    const { service, sessions } = createServiceBundle();
    sessions.appendMessage("s-sessions", "codex", {
      role: "user",
      content: "帮我排查支付超时和重试告警策略",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "s-sessions",
      currentAgentId: "codex",
      input: "/sessions",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Sessions (1)");
    expect(result.finalText).toContain("帮我排查支付超时和重试告警策略");
    expect(result.finalText).toMatch(/1\.\s.+\s(now|\d+m|\d+h|\d+d|\d+w|\d+mo|\d+y)\s<codex>\sx1/);
  });

  test("marks running sessions in /sessions output", () => {
    const { service, sessions } = createServiceBundle({
      isSessionRunning: (sessionId) => sessionId === "s-running",
    });
    sessions.appendMessage("s-running", "codex", {
      role: "user",
      content: "请帮我检查一个运行中的任务",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "s-running",
      currentAgentId: "codex",
      input: "/sessions",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("⟳ ");
  });

  test("clips overly long session name in /sessions output", () => {
    const { service, sessions } = createServiceBundle();
    sessions.appendMessage("s-long-name", "codex", {
      role: "user",
      content: "这是一个非常非常非常非常非常长的会话标题用于测试截断是否生效",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "s-long-name",
      currentAgentId: "codex",
      input: "/sessions",
    });
    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("…");
  });
});
