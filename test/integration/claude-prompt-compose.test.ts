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

/**
 * A probe script that captures both the CLI args and the composed prompt
 * passed as the last argument.
 */
function createArgsAndPromptProbeScript(params: {
  scriptPath: string;
  argsLogPath: string;
  promptPath: string;
}): void {
  const escapedArgsLog = JSON.stringify(params.argsLogPath);
  const escapedPromptPath = JSON.stringify(params.promptPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const argsLogPath = ${escapedArgsLog};
const promptPath = ${escapedPromptPath};

const existing = fs.existsSync(argsLogPath)
  ? JSON.parse(fs.readFileSync(argsLogPath, "utf-8"))
  : [];
existing.push(args);
fs.writeFileSync(argsLogPath, JSON.stringify(existing), "utf-8");

const prompt = args[args.length - 1] ?? "";
fs.writeFileSync(promptPath, prompt, "utf-8");

console.log("ok");
`;
  fs.writeFileSync(params.scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestrator(scriptPath: string): ChatOrchestrator {
  const backend = createClaudeCodeCliBackend({ command: scriptPath });
  if (!backend) {
    throw new Error("expected claude backend");
  }

  const registry = new AgentRegistry();
  registry.register(new ClaudeCodeAgentAdapter(backend));

  return new ChatOrchestrator({
    registry,
    hooks: new HookBus(),
    skillRuntime: new SkillRuntime(),
    toolRuntime: new ToolRuntime(),
    sessionStore: new InMemorySessionStore(),
    readabilityPolicy: new ReadabilityPolicy({ maxChars: 2000, maxLines: 50 }),
    defaultAgentId: "claude-code",
  });
}

describe("Claude Code prompt composition", () => {
  test("injects thinking depth preference into prompt and --effort into cli args", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-depth-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    const orchestrator = createOrchestrator(scriptPath);

    // Set thinking depth via /depth command so it flows into session metadata
    await orchestrator.chat({
      sessionId: "cc-depth",
      agentId: "claude-code",
      input: "/depth high",
    });

    await orchestrator.chat({
      sessionId: "cc-depth",
      agentId: "claude-code",
      input: "深入分析代码",
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Thinking depth preference: high");

    const allArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf-8")) as string[][];
    const args = allArgs[0] ?? [];
    expect(args.includes("--effort")).toBeTrue();
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  test("passes --model into cli args when model preference is set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-model-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    const orchestrator = createOrchestrator(scriptPath);

    // Set model via /model command so it flows into session metadata
    await orchestrator.chat({
      sessionId: "cc-model",
      agentId: "claude-code",
      input: "/model claude-opus-4-5",
    });

    await orchestrator.chat({
      sessionId: "cc-model",
      agentId: "claude-code",
      input: "请帮我生成代码",
    });

    const allArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf-8")) as string[][];
    const args = allArgs[0] ?? [];
    expect(args.includes("--model")).toBeTrue();
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-5");
  });

  test("does not inject --model or --effort when not set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-nomodel-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-nomodel",
      agentId: "claude-code",
      input: "简单回答",
    });

    const allArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf-8")) as string[][];
    const args = allArgs[0] ?? [];
    expect(args.includes("--model")).toBeFalse();
    expect(args.includes("--effort")).toBeFalse();
  });

  test("always injects --session-id into cli args", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-sessid-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-sessid",
      agentId: "claude-code",
      input: "hello",
    });

    const allArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf-8")) as string[][];
    const args = allArgs[0] ?? [];
    expect(args.includes("--session-id")).toBeTrue();
    const id = args[args.indexOf("--session-id") + 1];
    expect(typeof id).toBe("string");
    expect((id ?? "").length).toBeGreaterThan(0);
  });

  test("injects system directives into composed prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-directives-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    // Use HookBus with a beforeTurn hook to inject system directives
    const backend = createClaudeCodeCliBackend({ command: scriptPath });
    if (!backend) throw new Error("expected backend");

    const registry = new AgentRegistry();
    registry.register(new ClaudeCodeAgentAdapter(backend));

    const { HookBus } = await import("../../src/core/hooks");
    const hooks = new HookBus();
    hooks.register({
      id: "test.system.directive",
      beforeTurn: (ctx) => ({
        systemDirectives: ["输出格式必须是 JSON。", "不允许调用外部 API。"],
        ...(ctx.request.metadata ? { metadata: ctx.request.metadata } : {}),
      }),
    });

    const orchestrator = new ChatOrchestrator({
      registry,
      hooks,
      skillRuntime: new SkillRuntime(),
      toolRuntime: new ToolRuntime(),
      sessionStore: new InMemorySessionStore(),
      readabilityPolicy: new ReadabilityPolicy({ maxChars: 2000, maxLines: 50 }),
      defaultAgentId: "claude-code",
    });

    await orchestrator.chat({
      sessionId: "cc-directives",
      agentId: "claude-code",
      input: "生成用户数据",
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("System directives (must follow):");
    expect(prompt).toContain("输出格式必须是 JSON。");
    expect(prompt).toContain("不允许调用外部 API。");
    expect(prompt).toContain("User request:");
    expect(prompt).toContain("生成用户数据");
  });

  test("strips -p and --print from base args normalization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-strip-"));
    const scriptPath = path.join(root, "probe.mjs");
    const argsLogPath = path.join(root, "args.json");
    const promptPath = path.join(root, "prompt.txt");
    createArgsAndPromptProbeScript({ scriptPath, argsLogPath, promptPath });

    // Create backend with -p and --print in base args — they should be stripped
    const backend = createClaudeCodeCliBackend({
      command: scriptPath,
      args: ["-p", "--print", "{{prompt}}"],
    });
    if (!backend) throw new Error("expected backend");

    const registry = new AgentRegistry();
    registry.register(new ClaudeCodeAgentAdapter(backend));

    const orchestrator = new ChatOrchestrator({
      registry,
      hooks: new HookBus(),
      skillRuntime: new SkillRuntime(),
      toolRuntime: new ToolRuntime(),
      sessionStore: new InMemorySessionStore(),
      readabilityPolicy: new ReadabilityPolicy({ maxChars: 2000, maxLines: 50 }),
      defaultAgentId: "claude-code",
    });

    await orchestrator.chat({
      sessionId: "cc-strip",
      agentId: "claude-code",
      input: "test input",
    });

    const allArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf-8")) as string[][];
    const args = allArgs[0] ?? [];
    // The -p is re-added by the backend as the first arg (for print mode),
    // but the extra -p/--print/{{prompt}} from base args should not appear twice
    const printFlags = args.filter((a) => a === "-p" || a === "--print");
    expect(printFlags.length).toBe(1); // only the one the backend itself adds
    expect(args.filter((a) => a === "{{prompt}}").length).toBe(0);
  });
});
