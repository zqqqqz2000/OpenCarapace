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
import { ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode.js";
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
  registry.register(new ClaudeCodeAgentAdapter());

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
    const parsed = parseSlashCommand("/agent \"claude-code\"");
    expect(parsed?.name).toBe("agent");
    expect(parsed?.args).toEqual(["claude-code"]);
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
      input: "/agent claude-code",
    });

    expect(result.handled).toBeTrue();
    expect(result.agentId).toBe("claude-code");
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

  test("shares /model preference globally across sessions", () => {
    const service = createService();
    service.execute({
      sessionId: "s-model-global-a",
      currentAgentId: "codex",
      input: "/model gpt-5.1",
    });

    const status = service.execute({
      sessionId: "s-model-global-b",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(status.handled).toBeTrue();
    expect(status.finalText).toContain("- model: gpt-5.1");
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

  test("shares /depth globally across sessions", () => {
    const service = createService();
    service.execute({
      sessionId: "s-depth-global-a",
      currentAgentId: "codex",
      input: "/depth low",
    });

    const status = service.execute({
      sessionId: "s-depth-global-b",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(status.handled).toBeTrue();
    expect(status.finalText).toContain("- thinkingDepth: low");
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

  test("shares /sandbox by workspace and isolates different workspaces", () => {
    const service = createService();

    service.execute({
      sessionId: "agent.alpha.telegram.chat.main",
      currentAgentId: "codex",
      input: "/sandbox open",
    });

    const sameWorkspaceStatus = service.execute({
      sessionId: "agent.alpha.telegram.chat.thread-2",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(sameWorkspaceStatus.handled).toBeTrue();
    expect(sameWorkspaceStatus.finalText).toContain("- sandbox: danger-full-access");

    const otherWorkspaceStatus = service.execute({
      sessionId: "agent.beta.telegram.chat.main",
      currentAgentId: "codex",
      input: "/status",
    });
    expect(otherWorkspaceStatus.handled).toBeTrue();
    expect(otherWorkspaceStatus.finalText).toContain("- sandbox: (default)");
  });

  test("accepts sandbox short aliases", () => {
    const service = createService();

    const setResult = service.execute({
      sessionId: "s-sandbox-alias",
      currentAgentId: "codex",
      input: "/sandbox ws",
    });
    expect(setResult.handled).toBeTrue();
    expect(setResult.finalText).toContain("- sandbox: workspace-write");
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

  test("creates a new empty session on /new and keeps previous session intact", () => {
    const { service, sessions } = createServiceBundle();
    sessions.setMetadata("s-reset", "claude-code", {
      codex_thread_id: "thread-x",
      claude_session_id: "00000000-0000-4000-8000-000000000001",
    });

    const created = service.execute({
      sessionId: "s-reset",
      currentAgentId: "claude-code",
      input: "/new",
    });
    expect(created.handled).toBeTrue();
    expect(created.finalText).toContain("Started a new session.");
    expect(typeof created.sessionId).toBe("string");
    expect(created.sessionId).not.toBe("s-reset");

    const previousMetadata = sessions.getMetadata("s-reset");
    expect(previousMetadata.codex_thread_id).toBe("thread-x");
    expect(previousMetadata.claude_session_id).toBe("00000000-0000-4000-8000-000000000001");

    const nextId = String(created.sessionId ?? "");
    const nextMetadata = sessions.getMetadata(nextId);
    expect(nextMetadata.codex_thread_id).toBe("");
    expect(nextMetadata.claude_session_id).toBe("");
  });

  test("shows previous session name instead of session id when /new switches", () => {
    const { service, sessions } = createServiceBundle();
    sessions.setMetadata("s-reset-name", "claude-code", {
      session_name: "旧会话名称",
      session_name_source: "manual",
    });

    const created = service.execute({
      sessionId: "s-reset-name",
      currentAgentId: "claude-code",
      input: "/new",
    });

    expect(created.handled).toBeTrue();
    expect(created.finalText).toContain("Started a new session.");
    expect(created.finalText).toContain("- previous: 旧会话名称");
    expect(created.finalText).not.toContain("- previous: s-reset-name");
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

  test("treats /reset as unknown command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s-reset-removed",
      currentAgentId: "codex",
      input: "/reset",
    });
    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Unknown command: /reset");
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

  test("quotes current running session by /running", () => {
    const { service, sessions } = createServiceBundle({
      isSessionRunning: (sessionId) => sessionId === "s-running-quote",
    });
    sessions.appendMessage("s-running-quote", "codex", {
      role: "user",
      content: "定位线上支付超时根因",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "s-running-quote",
      currentAgentId: "codex",
      input: "/running",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Running quote:");
    expect(result.finalText).toContain('"定位线上支付超时根因"');
    expect(result.finalText).toContain("session=s-running-quote");
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

  test("filters /sessions by current project when session id is project-bound", () => {
    const { service, sessions } = createServiceBundle();
    sessions.appendMessage("agent.alpha.telegram.chat.main", "codex", {
      role: "user",
      content: "alpha issue",
      createdAt: Date.now(),
    });
    sessions.appendMessage("agent.beta.telegram.chat.main", "codex", {
      role: "user",
      content: "beta issue",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "agent.alpha.telegram.chat.main",
      currentAgentId: "codex",
      input: "/sessions",
    });
    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("- project: alpha");
    expect(result.finalText).toContain("alpha issue");
    expect(result.finalText).not.toContain("beta issue");
  });

  test("shows rename guidance by /rename", () => {
    const { service, sessions } = createServiceBundle();
    sessions.appendMessage("s-rename", "codex", {
      role: "user",
      content: "会话原始名称",
      createdAt: Date.now(),
    });

    const result = service.execute({
      sessionId: "s-rename",
      currentAgentId: "codex",
      input: "/rename",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Session rename");
    expect(result.finalText).toContain("Use /rename in Telegram");
  });
});
