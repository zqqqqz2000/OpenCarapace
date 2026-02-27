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

function createPromptProbeScript(scriptPath: string, promptPath: string): void {
  const escapedPromptPath = JSON.stringify(promptPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
fs.writeFileSync(${escapedPromptPath}, prompt, "utf-8");
console.log("ok");
`;
  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
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
    readabilityPolicy: new ReadabilityPolicy({ maxChars: 1000, maxLines: 20 }),
    defaultAgentId: "claude-code",
  });
}

describe("Claude Code prompt attachment path injection", () => {
  test("appends local attachment paths into claude user prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-image-"));
    const scriptPath = path.join(root, "probe-claude.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-image",
      agentId: "claude-code",
      input: "请看图并告诉我主要内容",
      metadata: {
        steer: true,
        attachmentPaths: ["/tmp/opencarapace/voice-a.ogg"],
        imagePaths: ["/tmp/opencarapace/image-a.png", "/tmp/opencarapace/image-b.jpg"],
      },
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Steer update:");
    expect(prompt).toContain("Attached local file paths (temporary files):");
    expect(prompt).toContain("1. /tmp/opencarapace/voice-a.ogg");
    expect(prompt).toContain("2. /tmp/opencarapace/image-a.png");
    expect(prompt).toContain("3. /tmp/opencarapace/image-b.jpg");
    expect(prompt).toContain("User request:");
    expect(prompt).toContain("请看图并告诉我主要内容");
  });

  test("deduplicates attachment paths across multiple metadata keys", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-dedup-"));
    const scriptPath = path.join(root, "probe-claude.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-dedup",
      agentId: "claude-code",
      input: "分析附件",
      metadata: {
        attachmentPaths: ["/tmp/opencarapace/doc.pdf"],
        localAttachmentPaths: ["/tmp/opencarapace/doc.pdf"],
        imagePaths: ["/tmp/opencarapace/doc.pdf"],
      },
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    const count = (prompt.match(/\/tmp\/opencarapace\/doc\.pdf/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("adds voice-only execution note when inbound is voice-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-voice-"));
    const scriptPath = path.join(root, "probe-claude.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-voice-only",
      agentId: "claude-code",
      input: "这是用户的语音输入，请直接理解语音内容并执行用户诉求，不要要求用户先转写。",
      metadata: {
        attachmentPaths: ["/tmp/opencarapace/voice-only.ogg"],
        telegram_voice_only_input: true,
      },
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Input mode note: this is a voice-only user input.");
    expect(prompt).toContain("execute the user's intent directly");
    expect(prompt).toContain("这是用户的语音输入");
  });

  test("adds voice-only note for voice_input_only metadata flag", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-claude-voice2-"));
    const scriptPath = path.join(root, "probe-claude.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "cc-voice-flag",
      agentId: "claude-code",
      input: "请执行语音指令",
      metadata: { voice_input_only: true },
    });

    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Input mode note: this is a voice-only user input.");
  });
});
