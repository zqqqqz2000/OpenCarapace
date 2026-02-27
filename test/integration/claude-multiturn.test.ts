import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createClaudeCodeCliBackend, ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";

// ---------------------------------------------------------------------------
// Script helpers
// ---------------------------------------------------------------------------

/**
 * A fake claude script that logs args, captures the composed prompt,
 * echoes back a configurable reply, and optionally exits with a given code.
 */
function createFakeClaudeScript(params: {
  scriptPath: string;
  callLogPath: string;
  promptLogPath?: string;
  reply?: string;
  exitCode?: number;
  /** If set, print this to stderr before exiting */
  stderrMessage?: string;
  /** If set, delay stdout by this many ms (simulates slow execution) */
  delayMs?: number;
}): void {
  const { scriptPath, callLogPath, promptLogPath, reply = "ok", exitCode = 0 } = params;
  const escapedLog = JSON.stringify(callLogPath);
  const escapedPrompt = JSON.stringify(promptLogPath ?? "");
  const escapedReply = JSON.stringify(reply);
  const escapedStderr = JSON.stringify(params.stderrMessage ?? "");
  const escapedDelay = String(params.delayMs ?? 0);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const callLogPath = ${escapedLog};
const promptLogPath = ${escapedPrompt};
const reply = ${escapedReply};
const stderrMsg = ${escapedStderr};
const delayMs = ${escapedDelay};
const exitCode = ${exitCode};

const calls = fs.existsSync(callLogPath)
  ? JSON.parse(fs.readFileSync(callLogPath, "utf-8"))
  : [];
calls.push(args);
fs.writeFileSync(callLogPath, JSON.stringify(calls), "utf-8");

if (promptLogPath) {
  const prompt = args[args.length - 1] ?? "";
  fs.writeFileSync(promptLogPath, prompt, "utf-8");
}

if (delayMs > 0) {
  await new Promise(r => setTimeout(r, delayMs));
}

if (stderrMsg) {
  process.stderr.write(stderrMsg + "\\n");
}

if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log(reply);
`;
  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestratorWithFakeClaude(scriptPath: string): ChatOrchestrator {
  const backend = createClaudeCodeCliBackend({ command: scriptPath });
  if (!backend) throw new Error("expected fake claude backend");

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

// ---------------------------------------------------------------------------
// Multi-turn conversation
// ---------------------------------------------------------------------------

describe("Claude Code multi-turn conversation", () => {
  test("reuses the same claude_session_id across turns within a session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-mt-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");

    // Reply with the --session-id that was passed so we can verify reuse
    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      reply: "placeholder", // overridden dynamically
    });

    // Script that echoes the session-id arg
    const echoScript = `#!/usr/bin/env bun
import fs from "node:fs";
const args = process.argv.slice(2);
const log = ${JSON.stringify(callLogPath)};
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf-8")) : [];
calls.push(args);
fs.writeFileSync(log, JSON.stringify(calls), "utf-8");
const idx = args.indexOf("--session-id");
console.log("session:" + (idx >= 0 ? args[idx + 1] : "missing"));
`;
    fs.writeFileSync(scriptPath, echoScript, { encoding: "utf-8", mode: 0o755 });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    const first = await orchestrator.chat({ sessionId: "cc-mt-1", agentId: "claude-code", input: "turn 1" });
    const firstSessionId = String(orchestrator.sessions.getMetadata("cc-mt-1").claude_session_id ?? "");
    expect(firstSessionId.length).toBeGreaterThan(0);
    expect(first.finalText).toContain(`session:${firstSessionId}`);

    const second = await orchestrator.chat({ sessionId: "cc-mt-1", input: "turn 2" });
    expect(second.finalText).toContain(`session:${firstSessionId}`);

    const third = await orchestrator.chat({ sessionId: "cc-mt-1", input: "turn 3" });
    expect(third.finalText).toContain(`session:${firstSessionId}`);

    const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[][];
    expect(calls.length).toBe(3);

    // All three turns must pass the same --session-id
    const ids = calls.map((c) => c[c.indexOf("--session-id") + 1]);
    expect(ids[0]).toBe(firstSessionId);
    expect(ids[1]).toBe(firstSessionId);
    expect(ids[2]).toBe(firstSessionId);
  });

  test("different sessions get independent claude_session_ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-mt-iso-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");

    const script = `#!/usr/bin/env bun
import fs from "node:fs";
const args = process.argv.slice(2);
const log = ${JSON.stringify(callLogPath)};
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf-8")) : [];
calls.push(args);
fs.writeFileSync(log, JSON.stringify(calls), "utf-8");
const idx = args.indexOf("--session-id");
console.log("session:" + (idx >= 0 ? args[idx + 1] : "missing"));
`;
    fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    await orchestrator.chat({ sessionId: "cc-iso-a", agentId: "claude-code", input: "hello from A" });
    await orchestrator.chat({ sessionId: "cc-iso-b", agentId: "claude-code", input: "hello from B" });

    const idA = String(orchestrator.sessions.getMetadata("cc-iso-a").claude_session_id ?? "");
    const idB = String(orchestrator.sessions.getMetadata("cc-iso-b").claude_session_id ?? "");
    expect(idA.length).toBeGreaterThan(0);
    expect(idB.length).toBeGreaterThan(0);
    expect(idA).not.toBe(idB);
  });

  test("new session after /new gets a fresh claude_session_id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-mt-new-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");

    const script = `#!/usr/bin/env bun
import fs from "node:fs";
const args = process.argv.slice(2);
const log = ${JSON.stringify(callLogPath)};
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf-8")) : [];
calls.push(args);
fs.writeFileSync(log, JSON.stringify(calls), "utf-8");
const idx = args.indexOf("--session-id");
console.log("session:" + (idx >= 0 ? args[idx + 1] : "missing"));
`;
    fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    await orchestrator.chat({ sessionId: "cc-mt-new", agentId: "claude-code", input: "first turn" });
    const firstId = String(orchestrator.sessions.getMetadata("cc-mt-new").claude_session_id ?? "");
    expect(firstId.length).toBeGreaterThan(0);

    const newCmd = await orchestrator.chat({ sessionId: "cc-mt-new", input: "/new" });
    expect(newCmd.finalText).toContain("Started a new session.");
    const nextSessionId = newCmd.sessionId;
    expect(nextSessionId).not.toBe("cc-mt-new");

    await orchestrator.chat({ sessionId: nextSessionId, input: "first turn in new session" });
    const secondId = String(orchestrator.sessions.getMetadata(nextSessionId).claude_session_id ?? "");
    expect(secondId.length).toBeGreaterThan(0);
    expect(secondId).not.toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// CLI error handling
// ---------------------------------------------------------------------------

describe("Claude Code CLI error handling", () => {
  test("surfaces error when CLI exits with non-zero code", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-err-"));
    const scriptPath = path.join(root, "fake-claude-fail.mjs");
    const callLogPath = path.join(root, "calls.json");

    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      exitCode: 1,
      stderrMessage: "fatal: cannot proceed",
    });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    await expect(
      orchestrator.chat({ sessionId: "cc-err-1", agentId: "claude-code", input: "do something" }),
    ).rejects.toThrow(/claude cli backend failed/i);
  });

  test("includes stderr content in error message on failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-stderr-"));
    const scriptPath = path.join(root, "fake-claude-stderr.mjs");
    const callLogPath = path.join(root, "calls.json");

    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      exitCode: 2,
      stderrMessage: "authentication-failed: token expired",
    });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    let errorMsg = "";
    try {
      await orchestrator.chat({ sessionId: "cc-stderr-1", agentId: "claude-code", input: "do something" });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    expect(errorMsg).toContain("authentication-failed");
  });

  test("returns fallback text when CLI exits cleanly but produces no output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-empty-"));
    const scriptPath = path.join(root, "fake-claude-empty.mjs");
    const callLogPath = path.join(root, "calls.json");

    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      reply: "",       // empty stdout
      exitCode: 0,
    });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    const result = await orchestrator.chat({
      sessionId: "cc-empty-1",
      agentId: "claude-code",
      input: "do something",
    });

    // BaseCodeAgentAdapter.fallbackText() should kick in
    expect(result.finalText.length).toBeGreaterThan(0);
    expect(result.finalText).not.toBe("");
  });

  test("stderr output alone does not break a successful run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-stderr-ok-"));
    const scriptPath = path.join(root, "fake-claude-stderr-ok.mjs");
    const callLogPath = path.join(root, "calls.json");

    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      reply: "task completed",
      exitCode: 0,
      stderrMessage: "warning: something minor",
    });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    const result = await orchestrator.chat({
      sessionId: "cc-stderr-ok-1",
      agentId: "claude-code",
      input: "do something",
    });

    expect(result.finalText).toContain("task completed");
  });
});

// ---------------------------------------------------------------------------
// Abort / stop
// ---------------------------------------------------------------------------

describe("Claude Code abort / /stop", () => {
  test("aborting via AbortSignal before start does not run the CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-abort-pre-"));
    const scriptPath = path.join(root, "fake-claude.mjs");
    const callLogPath = path.join(root, "calls.json");

    createFakeClaudeScript({ scriptPath, callLogPath, reply: "should not run" });

    const backend = createClaudeCodeCliBackend({ command: scriptPath });
    if (!backend) throw new Error("expected backend");

    const controller = new AbortController();
    controller.abort(new Error("pre-abort"));

    await expect(
      backend.execute(
        {
          sessionId: "s-abort-pre",
          prompt: "hello",
          messages: [],
          systemDirectives: [],
          abortSignal: controller.signal,
        },
        async () => {},
      ),
    ).rejects.toThrow(/pre-abort|aborted/i);

    // CLI should never have been called
    expect(fs.existsSync(callLogPath)).toBeFalse();
  });

  test("/stop cancels a running turn and produces abort error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-stop-"));
    const scriptPath = path.join(root, "fake-claude-slow.mjs");
    const callLogPath = path.join(root, "calls.json");

    // A script that takes 3s to respond — /stop should kill it first
    createFakeClaudeScript({
      scriptPath,
      callLogPath,
      reply: "this should not arrive",
      delayMs: 3000,
    });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);

    let chatError: unknown = null;
    const chatPromise = orchestrator
      .chat({ sessionId: "cc-stop-1", agentId: "claude-code", input: "slow task" })
      .catch((e) => {
        chatError = e;
      });

    // Give the turn time to start, then stop it
    await new Promise((r) => setTimeout(r, 200));
    const stopped = orchestrator.cancelRunningTurn("cc-stop-1", "user stopped");
    expect(stopped).toBeTrue();

    await chatPromise;
    expect(chatError).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-interactive (-p) mode: plan/permission prompts stream as plain text
// ---------------------------------------------------------------------------

describe("Claude Code non-interactive mode behavior", () => {
  test("all stdout is streamed as delta events", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-delta-"));
    const scriptPath = path.join(root, "fake-claude-multi-chunk.mjs");
    const callLogPath = path.join(root, "calls.json");

    // Script that outputs multiple lines (simulates plan text)
    const script = `#!/usr/bin/env bun
import fs from "node:fs";
const calls = [];
fs.writeFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(calls), "utf-8");
process.stdout.write("## Plan\\n");
process.stdout.write("1. Read the file\\n");
process.stdout.write("2. Apply the patch\\n");
process.stdout.write("3. Run tests\\n");
`;
    fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);
    const deltaTexts: string[] = [];

    const result = await orchestrator.chat({
      sessionId: "cc-delta-1",
      agentId: "claude-code",
      input: "show me the plan",
      onEvent: async (event) => {
        if (event.type === "delta" && "text" in event) {
          deltaTexts.push(event.text as string);
        }
      },
    });

    // All chunks should have been emitted as delta events
    expect(deltaTexts.length).toBeGreaterThan(0);
    const joined = deltaTexts.join("");
    expect(joined).toContain("Plan");
    expect(joined).toContain("Apply the patch");

    // finalText is the full accumulated stdout
    expect(result.finalText).toContain("Plan");
    expect(result.finalText).toContain("Run tests");
  });

  test("stdin is closed immediately — CLI cannot interactively prompt for input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-cc-stdin-"));
    const scriptPath = path.join(root, "fake-claude-stdin-check.mjs");
    const callLogPath = path.join(root, "calls.json");

    // Script that tries to read stdin; if stdin is closed it reads empty and exits
    const script = `#!/usr/bin/env bun
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(callLogPath)}, JSON.stringify([["called"]]), "utf-8");
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
// stdin closed with no data means non-interactive
const stdinWasEmpty = chunks.length === 0;
console.log("stdin_empty:" + stdinWasEmpty);
`;
    fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    const orchestrator = createOrchestratorWithFakeClaude(scriptPath);
    const result = await orchestrator.chat({
      sessionId: "cc-stdin-1",
      agentId: "claude-code",
      input: "check stdin",
    });

    expect(result.finalText).toContain("stdin_empty:true");
  });
});
