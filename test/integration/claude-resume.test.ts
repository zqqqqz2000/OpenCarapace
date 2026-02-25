import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createClaudeCodeCliBackend, ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { FileSessionStore, InMemorySessionStore, type SessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";

function createFakeClaudeScript(params: {
  scriptPath: string;
  callLogPath: string;
}): void {
  const { scriptPath, callLogPath } = params;
  const escapedLog = JSON.stringify(callLogPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const callLogPath = ${escapedLog};

const calls = fs.existsSync(callLogPath)
  ? JSON.parse(fs.readFileSync(callLogPath, "utf-8"))
  : [];
calls.push(args);
fs.writeFileSync(callLogPath, JSON.stringify(calls), "utf-8");

const sessionIndex = args.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? String(args[sessionIndex + 1] ?? "").trim() : "";
console.log("reply@" + (sessionId || "missing"));
`;
  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestratorWithFakeClaude(
  scriptPath: string,
  sessionStore: SessionStore = new InMemorySessionStore(),
): ChatOrchestrator {
  const backend = createClaudeCodeCliBackend({
    command: scriptPath,
    args: ["-p", "{{prompt}}"],
  });
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
    sessionStore,
    readabilityPolicy: new ReadabilityPolicy({
      maxChars: 1000,
      maxLines: 20,
    }),
    defaultAgentId: "claude-code",
  });
}

describe("Claude session continuity", () => {
  test("reuses --session-id across turns and clears it on /new", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-session-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");
    createFakeClaudeScript({ scriptPath, callLogPath });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    const first = await orchestrator.chat({
      sessionId: "s-claude",
      agentId: "claude-code",
      input: "first",
    });
    expect(first.finalText).toContain("reply@");

    const firstMetadata = orchestrator.sessions.getMetadata("s-claude");
    expect(typeof firstMetadata.claude_session_id).toBe("string");
    const firstSessionId = String(firstMetadata.claude_session_id ?? "");
    expect(firstSessionId.length).toBeGreaterThan(0);

    const second = await orchestrator.chat({
      sessionId: "s-claude",
      input: "second",
    });
    expect(second.finalText).toContain(`reply@${firstSessionId}`);

    await orchestrator.chat({
      sessionId: "s-claude",
      input: "/new",
    });
    const third = await orchestrator.chat({
      sessionId: "s-claude",
      input: "third",
    });
    expect(third.finalText).toContain("reply@");

    const thirdMetadata = orchestrator.sessions.getMetadata("s-claude");
    const thirdSessionId = String(thirdMetadata.claude_session_id ?? "");
    expect(thirdSessionId.length).toBeGreaterThan(0);
    expect(thirdSessionId).not.toBe(firstSessionId);

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(3);
    const firstCall = calls[0] ?? [];
    const secondCall = calls[1] ?? [];
    const thirdCall = calls[2] ?? [];

    expect(firstCall.includes("--session-id")).toBeTrue();
    expect(secondCall.includes("--session-id")).toBeTrue();
    expect(thirdCall.includes("--session-id")).toBeTrue();
    expect(secondCall[secondCall.indexOf("--session-id") + 1]).toBe(firstSessionId);
    expect(thirdCall[thirdCall.indexOf("--session-id") + 1]).toBe(thirdSessionId);
  });

  test("persists claude session id across orchestrator restart with file session store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-session-file-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");
    const sessionFilePath = path.join(root, "sessions.json");
    createFakeClaudeScript({ scriptPath, callLogPath });

    const orchestratorA = createOrchestratorWithFakeClaude(
      scriptPath,
      new FileSessionStore({ filePath: sessionFilePath }),
    );
    await orchestratorA.chat({
      sessionId: "s-persist",
      agentId: "claude-code",
      input: "first",
    });
    const persisted = String(orchestratorA.sessions.getMetadata("s-persist").claude_session_id ?? "");
    expect(persisted.length).toBeGreaterThan(0);

    const orchestratorB = createOrchestratorWithFakeClaude(
      scriptPath,
      new FileSessionStore({ filePath: sessionFilePath }),
    );
    await orchestratorB.chat({
      sessionId: "s-persist",
      input: "second",
    });

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(2);
    const secondCall = calls[1] ?? [];
    expect(secondCall.includes("--session-id")).toBeTrue();
    expect(secondCall[secondCall.indexOf("--session-id") + 1]).toBe(persisted);
  });
});
