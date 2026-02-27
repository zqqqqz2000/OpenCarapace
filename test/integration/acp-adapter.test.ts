/**
 * End-to-end tests for AcpAgentAdapter.
 *
 * Strategy: write a fake ACP "agent" script that speaks the real ACP stdio
 * protocol (AgentSideConnection + ndJsonStream over stdin/stdout).  The
 * adapter spawns that script just as it would a real `codex-acp` or
 * `claude-acp` binary, so the tests exercise the full
 *   AcpAgentAdapter → spawn → ACP protocol → response
 * path without hitting any real AI backend.
 *
 * Important: fake scripts must be written inside the project root so that Bun
 * resolves `@agentclientprotocol/sdk` (and its peer dep `zod`) from the
 * project's node_modules rather than the global Bun cache.
 *
 * The fake agent:
 *  - tracks every prompt() call in `callLogPath` ({ sessionId, turn, promptText })
 *  - allocates monotonically-increasing session IDs via `counterPath`
 *  - echoes "reply@<sessionId>#<turn>" so tests can assert session reuse
 *  - optionally emits a tool_call sessionUpdate (→ tests "tooling" status event)
 *  - optionally delays before responding (→ abort tests)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AcpAgentAdapter } from "../../src/adapters/acp";
import { AgentRegistry } from "../../src/core/agent";
import { HookBus } from "../../src/core/hooks";
import { ChatOrchestrator } from "../../src/core/orchestrator";
import { FileSessionStore, InMemorySessionStore, type SessionStore } from "../../src/core/session";
import { SkillRuntime } from "../../src/core/skills";
import { ToolRuntime } from "../../src/core/tools";
import { ReadabilityPolicy } from "../../src/core/ux-policy";

// Project root – scripts written here so bun resolves node_modules correctly
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// Fake ACP agent script factory
// ---------------------------------------------------------------------------

function createFakeAcpScript(params: {
  /** Must be inside PROJECT_ROOT for module resolution */
  scriptPath: string;
  callLogPath: string;
  counterPath: string;
  emitToolCall?: boolean;
  delayMs?: number;
}): void {
  const { scriptPath, callLogPath, counterPath } = params;
  const escapedLog = JSON.stringify(callLogPath);
  const escapedCounter = JSON.stringify(counterPath);
  const emitToolCall = params.emitToolCall ? "true" : "false";
  const delayMs = String(params.delayMs ?? 0);

  const script = `// fake-acp-agent – spawned by acp-adapter.test.ts
import fs from "node:fs";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const callLogPath = ${escapedLog};
const counterPath = ${escapedCounter};
const emitToolCall = ${emitToolCall};
const delayMs = ${delayMs};

let currentSessionId = null;
let turnCount = 0;
let cancelled = false;

function allocateSessionNumber() {
  const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf-8") || "0") : 0;
  const next = n + 1;
  fs.writeFileSync(counterPath, String(next), "utf-8");
  return next;
}

function appendCallLog(entry) {
  const existing = fs.existsSync(callLogPath) ? JSON.parse(fs.readFileSync(callLogPath, "utf-8")) : [];
  existing.push(entry);
  fs.writeFileSync(callLogPath, JSON.stringify(existing), "utf-8");
}

// ndJsonStream(output, input):
//   output → where we WRITE (→ process.stdout, client reads)
//   input  → where we READ  (← process.stdin, client writes)
const serverStream = ndJsonStream(
  new WritableStream({
    write(chunk) { return new Promise((ok, rej) => process.stdout.write(chunk, (e) => e ? rej(e) : ok())); },
    close() { return new Promise((r) => process.stdout.end(r)); },
  }),
  new ReadableStream({ start(ctrl) {
    process.stdin.on("data", (c) => ctrl.enqueue(new Uint8Array(c)));
    process.stdin.on("end", () => ctrl.close());
    process.stdin.on("error", (e) => ctrl.error(e));
  }}),
);

const conn = new AgentSideConnection((_client) => ({
  async initialize(_p) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods: [] };
  },
  async newSession(_p) {
    const n = allocateSessionNumber();
    currentSessionId = "acp-session-" + n;
    turnCount = 0;
    return { sessionId: currentSessionId };
  },
  async loadSession(_p) { return {}; },
  async authenticate(_p) {},
  async prompt(params) {
    cancelled = false;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (cancelled) return { stopReason: "cancelled" };

    turnCount++;
    const sid = currentSessionId ?? "unknown";
    const promptText = (params.prompt ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join(" ");

    appendCallLog({ sessionId: sid, turn: turnCount, promptText });

    if (emitToolCall) {
      await _client.sessionUpdate({
        sessionId: sid,
        update: { sessionUpdate: "tool_call", toolCallId: "fake-tool-1", title: "fake_tool", status: "in_progress" },
      });
    }

    await _client.sessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply@" + sid + "#" + turnCount } },
    });

    return { stopReason: "end_turn" };
  },
  async cancel(_p) { cancelled = true; },
}), serverStream);

await new Promise((r) => {
  conn.signal.addEventListener("abort", r, { once: true });
  process.stdin.on("close", r);
});
`;

  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Orchestrator factory
// ---------------------------------------------------------------------------

function createOrchestratorWithFakeAcp(
  scriptPath: string,
  agentId: "codex" | "claude-code" = "codex",
  sessionStore: SessionStore = new InMemorySessionStore(),
): ChatOrchestrator {
  // spawn: bun run <scriptPath> with project cwd for correct module resolution
  const adapter = new AcpAgentAdapter({
    id: agentId,
    displayName: agentId === "codex" ? "Codex (ACP)" : "Claude Code (ACP)",
    // Use `bun run <script>` via a wrapper so Bun resolves from project node_modules.
    // AcpAgentAdapter.command is passed directly to spawn() so we set it to the
    // bun executable and pass the script as the first arg element.
    command: process.execPath,
    args: ["run", scriptPath],
    cwd: PROJECT_ROOT,
  });

  const registry = new AgentRegistry();
  registry.register(adapter);

  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore,
    readabilityPolicy: new ReadabilityPolicy({ maxChars: 2000, maxLines: 40 }),
    defaultAgentId: agentId,
  });
}

// ---------------------------------------------------------------------------
// Multi-turn session reuse
// ---------------------------------------------------------------------------

describe("AcpAgentAdapter – multi-turn session reuse", () => {
  test("codex: reuses the same ACP session (same process) across turns within one orchestrator session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-reuse-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-reuse-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");

      const first = await orchestrator.chat({ sessionId: "s-acp-1", agentId: "codex", input: "turn 1" });
      expect(first.finalText).toContain("acp-session-1");
      expect(first.finalText).toContain("#1");

      const second = await orchestrator.chat({ sessionId: "s-acp-1", input: "turn 2" });
      expect(second.finalText).toContain("acp-session-1");
      expect(second.finalText).toContain("#2");

      const third = await orchestrator.chat({ sessionId: "s-acp-1", input: "turn 3" });
      expect(third.finalText).toContain("acp-session-1");
      expect(third.finalText).toContain("#3");

      const calls = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as Array<{ sessionId: string; turn: number }>;
      expect(calls.length).toBe(3);
      expect(calls.every((c) => c.sessionId === "acp-session-1")).toBeTrue();
      expect(calls.map((c) => c.turn)).toEqual([1, 2, 3]);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("claude-code: reuses ACP session across turns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-cc-reuse-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-cc-reuse-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "claude-code");

      const first = await orchestrator.chat({ sessionId: "s-cc-acp-1", agentId: "claude-code", input: "hello" });
      expect(first.finalText).toContain("acp-session-1");

      const second = await orchestrator.chat({ sessionId: "s-cc-acp-1", input: "follow up" });
      expect(second.finalText).toContain("acp-session-1");
      expect(second.finalText).toContain("#2");
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("different orchestrator sessions get independent ACP sessions (each spawns its own process)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-iso-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-iso-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");

      const resultA = await orchestrator.chat({ sessionId: "s-iso-a", agentId: "codex", input: "hello from A" });
      const resultB = await orchestrator.chat({ sessionId: "s-iso-b", agentId: "codex", input: "hello from B" });

      // Each session spawns its own ACP process → separate session numbers
      const sidA = resultA.finalText.match(/acp-session-(\d+)/)?.[1];
      const sidB = resultB.finalText.match(/acp-session-(\d+)/)?.[1];
      expect(sidA).toBeDefined();
      expect(sidB).toBeDefined();
      expect(sidA).not.toBe(sidB);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("/new switches to a fresh ACP session (new process spawn)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-new-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-new-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");

      const first = await orchestrator.chat({ sessionId: "s-acp-new", agentId: "codex", input: "first turn" });
      expect(first.finalText).toContain("acp-session-1");

      const newCmd = await orchestrator.chat({ sessionId: "s-acp-new", input: "/new" });
      expect(newCmd.finalText).toContain("Started a new session.");
      const nextSessionId = newCmd.sessionId;
      expect(nextSessionId).not.toBe("s-acp-new");

      const afterNew = await orchestrator.chat({ sessionId: nextSessionId, input: "first turn in new session" });
      // New orchestrator session → new ACP process → session number increments
      expect(afterNew.finalText).toContain("acp-session-2");
      expect(afterNew.finalText).toContain("#1");
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Memory / metadata persistence
// ---------------------------------------------------------------------------

describe("AcpAgentAdapter – memory and metadata", () => {
  test("acp_session_id is stored in orchestrator session metadata after first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-meta-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-meta-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");
      await orchestrator.chat({ sessionId: "s-meta", agentId: "codex", input: "hello" });

      const metadata = orchestrator.sessions.getMetadata("s-meta");
      expect(typeof metadata.acp_session_id).toBe("string");
      expect(String(metadata.acp_session_id).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("orchestrator session messages accumulate correctly across multi turns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-mem-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-mem-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");

      await orchestrator.chat({ sessionId: "s-mem", agentId: "codex", input: "turn 1" });
      expect(orchestrator.sessions.snapshot("s-mem")?.messages.length).toBe(2); // user+assistant

      await orchestrator.chat({ sessionId: "s-mem", input: "turn 2" });
      expect(orchestrator.sessions.snapshot("s-mem")?.messages.length).toBe(4);

      await orchestrator.chat({ sessionId: "s-mem", input: "turn 3" });
      expect(orchestrator.sessions.snapshot("s-mem")?.messages.length).toBe(6);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 30000);

  test("acp_session_id persists to FileSessionStore and survives orchestrator restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-persist-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-persist-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    const sessionFilePath = path.join(root, "sessions.json");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchA = createOrchestratorWithFakeAcp(
        scriptPath,
        "codex",
        new FileSessionStore({ filePath: sessionFilePath }),
      );
      await orchA.chat({ sessionId: "s-persist", agentId: "codex", input: "first" });
      const savedAcpId = String(orchA.sessions.getMetadata("s-persist").acp_session_id ?? "");
      expect(savedAcpId.length).toBeGreaterThan(0);

      // Simulate restart: new orchestrator, same FileSessionStore
      const orchB = createOrchestratorWithFakeAcp(
        scriptPath,
        "codex",
        new FileSessionStore({ filePath: sessionFilePath }),
      );
      const metaB = orchB.sessions.getMetadata("s-persist");
      expect(String(metaB.acp_session_id ?? "")).toBe(savedAcpId);
      expect(orchB.sessions.snapshot("s-persist")?.messages.length).toBe(2);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Event streaming
// ---------------------------------------------------------------------------

describe("AcpAgentAdapter – event streaming", () => {
  test("emits thinking status event and result event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-events-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-events-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");
      const result = await orchestrator.chat({ sessionId: "s-events", agentId: "codex", input: "go" });

      expect(result.events.some((e) => e.type === "status" && e.phase === "thinking")).toBeTrue();
      expect(result.events.some((e) => e.type === "result")).toBeTrue();
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("emits delta events for each streamed text chunk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-delta-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-delta-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");
      const deltas: string[] = [];

      const result = await orchestrator.chat({
        sessionId: "s-delta",
        agentId: "codex",
        input: "stream me",
        onEvent: async (e) => {
          if (e.type === "delta" && "text" in e) {
            deltas.push(e.text as string);
          }
        },
      });

      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("")).toContain("reply@");
      expect(result.finalText).toContain("acp-session-1");
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);

  test("emits tooling status event when agent sends tool_call update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-toolcall-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-toolcall-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    createFakeAcpScript({ scriptPath, callLogPath, counterPath, emitToolCall: true });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");
      const result = await orchestrator.chat({ sessionId: "s-toolcall", agentId: "codex", input: "use a tool" });

      expect(result.events.some((e) => e.type === "status" && e.phase === "tooling")).toBeTrue();
      expect(result.finalText).toContain("reply@");
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Abort / /stop
// ---------------------------------------------------------------------------

describe("AcpAgentAdapter – abort and /stop", () => {
  test("/stop cancels a running ACP turn and results in an error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-acp-stop-"));
    const scriptPath = path.join(PROJECT_ROOT, `test-fake-acp-stop-${Date.now()}.mjs`);
    const callLogPath = path.join(root, "calls.json");
    const counterPath = path.join(root, "counter.txt");
    // 4-second delay ensures /stop arrives well before the response
    createFakeAcpScript({ scriptPath, callLogPath, counterPath, delayMs: 4000 });

    try {
      const orchestrator = createOrchestratorWithFakeAcp(scriptPath, "codex");

      let chatError: unknown = null;
      const chatPromise = orchestrator
        .chat({ sessionId: "s-acp-stop", agentId: "codex", input: "slow task" })
        .catch((e) => { chatError = e; });

      // Wait for the turn to start before stopping
      await new Promise((r) => setTimeout(r, 400));
      const stopped = orchestrator.cancelRunningTurn("s-acp-stop", "user stopped");
      expect(stopped).toBeTrue();

      await chatPromise;
      expect(chatError).not.toBeNull();
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }, 20000);
});
