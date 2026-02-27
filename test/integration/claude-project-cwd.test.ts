import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createClaudeCodeCliBackend, ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode";
import { AgentRegistry } from "../../src/core/agent";
import { HookBus } from "../../src/core/hooks";
import { ChatOrchestrator } from "../../src/core/orchestrator";
import { InMemorySessionStore } from "../../src/core/session";
import { SkillRuntime } from "../../src/core/skills";
import { ToolRuntime } from "../../src/core/tools";
import { ReadabilityPolicy } from "../../src/core/ux-policy";

function createFakeClaudeScript(params: { scriptPath: string; cwdLogPath: string }): void {
  const escapedCwdLog = JSON.stringify(params.cwdLogPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const cwdLogPath = ${escapedCwdLog};
const logs = fs.existsSync(cwdLogPath)
  ? JSON.parse(fs.readFileSync(cwdLogPath, "utf-8"))
  : [];
logs.push(process.cwd());
fs.writeFileSync(cwdLogPath, JSON.stringify(logs), "utf-8");
console.log("ok");
`;
  fs.writeFileSync(params.scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestratorWithFakeClaude(scriptPath: string): ChatOrchestrator {
  const backend = createClaudeCodeCliBackend({ command: scriptPath });
  if (!backend) {
    throw new Error("expected fake claude backend");
  }

  const registry = new AgentRegistry();
  registry.register(new ClaudeCodeAgentAdapter(backend));

  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore: new InMemorySessionStore(),
    readabilityPolicy: new ReadabilityPolicy({ maxChars: 1000, maxLines: 20 }),
    defaultAgentId: "claude-code",
  });
}

describe("Claude Code execution cwd with project metadata", () => {
  test("uses project subdir and falls back to project root when project is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-cwd-"));
    const projectRoot = path.join(root, "projects");
    const alphaDir = path.join(projectRoot, "alpha");
    fs.mkdirSync(alphaDir, { recursive: true });

    const scriptPath = path.join(root, "fake-claude-cwd.mjs");
    const cwdLogPath = path.join(root, "cwd-log.json");
    createFakeClaudeScript({ scriptPath, cwdLogPath });

    const projectRootReal = fs.realpathSync(projectRoot);
    const alphaDirReal = fs.realpathSync(alphaDir);

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    await orchestrator.chat({
      sessionId: "cc-project-alpha",
      agentId: "claude-code",
      input: "hello alpha",
      metadata: {
        project_root_dir: projectRoot,
        project_name: "alpha",
        project_key: "alpha",
      },
    });

    await orchestrator.chat({
      sessionId: "cc-project-missing",
      agentId: "claude-code",
      input: "hello missing",
      metadata: {
        project_root_dir: projectRoot,
        project_name: "missing-project",
        project_key: "missing-project",
      },
    });

    await orchestrator.chat({
      sessionId: "cc-project-traversal",
      agentId: "claude-code",
      input: "hello traversal",
      metadata: {
        project_root_dir: projectRoot,
        project_name: "../../outside",
        project_key: "../../outside",
      },
    });

    const cwdLogs = JSON.parse(fs.readFileSync(cwdLogPath, "utf-8")) as string[];
    expect(cwdLogs.length).toBe(3);
    expect(cwdLogs[0]).toBe(alphaDirReal);
    expect(cwdLogs[1]).toBe(projectRootReal);
    expect(cwdLogs[2]).toBe(projectRootReal);
  });

  test("uses project_key with URL-encoded name to resolve correct directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-cwd-encoded-"));
    const projectRoot = path.join(root, "projects");
    const myAppDir = path.join(projectRoot, "my.app");
    fs.mkdirSync(myAppDir, { recursive: true });

    const scriptPath = path.join(root, "fake-claude-encoded.mjs");
    const cwdLogPath = path.join(root, "cwd-log.json");
    createFakeClaudeScript({ scriptPath, cwdLogPath });

    const myAppDirReal = fs.realpathSync(myAppDir);

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    await orchestrator.chat({
      sessionId: "cc-project-encoded",
      agentId: "claude-code",
      input: "hello encoded",
      metadata: {
        project_root_dir: projectRoot,
        project_key: "my%2Eapp",
      },
    });

    const cwdLogs = JSON.parse(fs.readFileSync(cwdLogPath, "utf-8")) as string[];
    expect(cwdLogs[0]).toBe(myAppDirReal);
  });
});
