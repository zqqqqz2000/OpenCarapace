import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createCodexCliBackend, CodexAgentAdapter } from "../../src/adapters/codex";
import { AgentRegistry } from "../../src/core/agent";
import { HookBus } from "../../src/core/hooks";
import { ChatOrchestrator } from "../../src/core/orchestrator";
import { InMemorySessionStore } from "../../src/core/session";
import { SkillRuntime } from "../../src/core/skills";
import { ToolRuntime } from "../../src/core/tools";
import { ReadabilityPolicy } from "../../src/core/ux-policy";

function createFakeCodexScript(params: { scriptPath: string; cwdLogPath: string }): void {
  const escapedCwdLog = JSON.stringify(params.cwdLogPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const cwdLogPath = ${escapedCwdLog};
const logs = fs.existsSync(cwdLogPath)
  ? JSON.parse(fs.readFileSync(cwdLogPath, "utf-8"))
  : [];
logs.push(process.cwd());
fs.writeFileSync(cwdLogPath, JSON.stringify(logs), "utf-8");

console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-cwd" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "ok",
    },
  }),
);
console.log(
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
    },
  }),
);
`;
  fs.writeFileSync(params.scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestratorWithFakeCodex(scriptPath: string): ChatOrchestrator {
  const backend = createCodexCliBackend({
    command: scriptPath,
    args: ["exec", "{{prompt}}"],
  });
  if (!backend) {
    throw new Error("expected fake codex backend");
  }

  const registry = new AgentRegistry();
  registry.register(new CodexAgentAdapter({ backend }));

  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore: new InMemorySessionStore(),
    readabilityPolicy: new ReadabilityPolicy({
      maxChars: 1000,
      maxLines: 20,
    }),
    defaultAgentId: "codex",
  });
}

describe("Codex execution cwd with project metadata", () => {
  test("uses project subdir and falls back to project root when project is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-cwd-"));
    const projectRoot = path.join(root, "projects");
    const alphaDir = path.join(projectRoot, "alpha");
    fs.mkdirSync(alphaDir, { recursive: true });

    const scriptPath = path.join(root, "fake-codex-cwd.mjs");
    const cwdLogPath = path.join(root, "cwd-log.json");
    createFakeCodexScript({ scriptPath, cwdLogPath });
    const projectRootReal = fs.realpathSync(projectRoot);
    const alphaDirReal = fs.realpathSync(alphaDir);

    const orchestrator = createOrchestratorWithFakeCodex(scriptPath);

    await orchestrator.chat({
      sessionId: "s-project-alpha",
      agentId: "codex",
      input: "hello alpha",
      metadata: {
        project_root_dir: projectRoot,
        project_name: "alpha",
        project_key: "alpha",
      },
    });

    await orchestrator.chat({
      sessionId: "s-project-missing",
      agentId: "codex",
      input: "hello missing",
      metadata: {
        project_root_dir: projectRoot,
        project_name: "missing-project",
        project_key: "missing-project",
      },
    });

    await orchestrator.chat({
      sessionId: "s-project-traversal",
      agentId: "codex",
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
});
