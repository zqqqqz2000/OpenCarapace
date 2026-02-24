import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createCodexCliBackend, CodexAgentAdapter } from "../../src/adapters/codex.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";

function createPromptProbeScript(scriptPath: string, promptPath: string): void {
  const escapedPromptPath = JSON.stringify(promptPath);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
fs.writeFileSync(${escapedPromptPath}, prompt, "utf-8");

console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-image-1" }));
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
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`;
  fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function createOrchestrator(scriptPath: string): ChatOrchestrator {
  const backend = createCodexCliBackend({
    command: scriptPath,
    args: ["exec", "{{prompt}}"],
  });
  if (!backend) {
    throw new Error("expected codex backend");
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

describe("Codex prompt attachment path injection", () => {
  test("appends local attachment paths into codex user prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-image-"));
    const scriptPath = path.join(root, "probe-codex.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "s-image",
      agentId: "codex",
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

  test("adds voice-only execution note when inbound is voice-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-voice-"));
    const scriptPath = path.join(root, "probe-codex.mjs");
    const promptPath = path.join(root, "prompt.txt");
    createPromptProbeScript(scriptPath, promptPath);

    const orchestrator = createOrchestrator(scriptPath);
    await orchestrator.chat({
      sessionId: "s-voice-only",
      agentId: "codex",
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
});
