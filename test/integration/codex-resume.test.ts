import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createCodexCliBackend, CodexAgentAdapter } from "../../src/adapters/codex.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { FileSessionStore, InMemorySessionStore, type SessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";

function createFakeCodexScript(params: {
  scriptPath: string;
  callLogPath: string;
  counterPath: string;
}): void {
  const { scriptPath, callLogPath, counterPath } = params;
  const escapedLog = JSON.stringify(callLogPath);
  const escapedCounter = JSON.stringify(counterPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const callLogPath = ${escapedLog};
const counterPath = ${escapedCounter};

const calls = fs.existsSync(callLogPath)
  ? JSON.parse(fs.readFileSync(callLogPath, "utf-8"))
  : [];
calls.push(args);
fs.writeFileSync(callLogPath, JSON.stringify(calls), "utf-8");

let threadId = "";
const resumeIndex = args.indexOf("resume");
if (resumeIndex >= 0) {
  threadId = (args[resumeIndex + 1] ?? "").trim();
}

if (!threadId) {
  const current = fs.existsSync(counterPath)
    ? Number(fs.readFileSync(counterPath, "utf-8") || "0")
    : 0;
  const next = current + 1;
  fs.writeFileSync(counterPath, String(next), "utf-8");
  threadId = "thread-" + String(next);
}

console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "reply@" + threadId,
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
  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestratorWithFakeCodex(
  scriptPath: string,
  sessionStore: SessionStore = new InMemorySessionStore(),
): ChatOrchestrator {
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
    sessionStore,
    readabilityPolicy: new ReadabilityPolicy({
      maxChars: 1000,
      maxLines: 20,
    }),
    defaultAgentId: "codex",
  });
}

describe("Codex resume-only conversation flow", () => {
  test("uses exec on first turn, resume on next turns, and /new clears codex thread binding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-resume-"));
    const scriptPath = path.join(root, "fake-codex.mjs");
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeCodexScript({ scriptPath, callLogPath, counterPath });

    const orchestrator = createOrchestratorWithFakeCodex(scriptPath);

    const first = await orchestrator.chat({
      sessionId: "s-resume",
      agentId: "codex",
      input: "first",
    });
    expect(first.finalText).toContain("thread-1");

    const second = await orchestrator.chat({
      sessionId: "s-resume",
      input: "second",
    });
    expect(second.finalText).toContain("thread-1");

    await orchestrator.chat({
      sessionId: "s-resume",
      input: "/new",
    });

    const third = await orchestrator.chat({
      sessionId: "s-resume",
      input: "third",
    });
    expect(third.finalText).toContain("thread-2");

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(3);

    const firstCall = calls[0] ?? [];
    const secondCall = calls[1] ?? [];
    const thirdCall = calls[2] ?? [];

    expect(firstCall.includes("exec")).toBeTrue();
    expect(firstCall.includes("resume")).toBeFalse();

    expect(secondCall.includes("exec")).toBeTrue();
    expect(secondCall.includes("resume")).toBeTrue();
    const resumeThread = secondCall[secondCall.indexOf("resume") + 1];
    expect(resumeThread).toBe("thread-1");

    expect(thirdCall.includes("exec")).toBeTrue();
    expect(thirdCall.includes("resume")).toBeFalse();

    const metadata = orchestrator.sessions.getMetadata("s-resume");
    expect(metadata.codex_thread_id).toBe("thread-2");
  });

  test("persists codex thread binding across orchestrator restart with file session store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-resume-file-"));
    const scriptPath = path.join(root, "fake-codex.mjs");
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    const sessionFilePath = path.join(root, "sessions.json");
    createFakeCodexScript({ scriptPath, callLogPath, counterPath });

    const orchestratorA = createOrchestratorWithFakeCodex(
      scriptPath,
      new FileSessionStore({ filePath: sessionFilePath }),
    );
    await orchestratorA.chat({
      sessionId: "s-persist",
      agentId: "codex",
      input: "first",
    });

    const orchestratorB = createOrchestratorWithFakeCodex(
      scriptPath,
      new FileSessionStore({ filePath: sessionFilePath }),
    );
    const second = await orchestratorB.chat({
      sessionId: "s-persist",
      input: "second",
    });

    expect(second.finalText).toContain("thread-1");

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(2);
    const secondCall = calls[1] ?? [];
    expect(secondCall.includes("resume")).toBeTrue();
    const resumeThread = secondCall[secondCall.indexOf("resume") + 1];
    expect(resumeThread).toBe("thread-1");
  });

  test("passes sandbox mode from /sandbox command into codex cli args", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-sandbox-"));
    const scriptPath = path.join(root, "fake-codex.mjs");
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeCodexScript({ scriptPath, callLogPath, counterPath });

    const orchestrator = createOrchestratorWithFakeCodex(scriptPath);
    await orchestrator.chat({
      sessionId: "s-sandbox",
      agentId: "codex",
      input: "/sandbox workspace-write",
    });

    await orchestrator.chat({
      sessionId: "s-sandbox",
      agentId: "codex",
      input: "run with sandbox",
    });

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(1);
    const call = calls[0] ?? [];
    expect(call.includes("--sandbox")).toBeTrue();
    const sandboxValue = call[call.indexOf("--sandbox") + 1];
    expect(sandboxValue).toBe("workspace-write");
  });
});
