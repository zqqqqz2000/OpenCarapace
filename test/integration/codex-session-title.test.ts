import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createCodexSessionTitleGenerator } from "../../src/adapters/codex.js";

function createFakeCodexTitleScript(params: {
  scriptPath: string;
  callLogPath: string;
  titleText: string;
}): void {
  const escapedLog = JSON.stringify(params.callLogPath);
  const escapedTitle = JSON.stringify(params.titleText);
  const script = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const callLogPath = ${escapedLog};
fs.writeFileSync(callLogPath, JSON.stringify(args), "utf-8");

console.log(JSON.stringify({ type: "thread.started", thread_id: "title-thread-1" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: ${escapedTitle},
    },
  }),
);
console.log(JSON.stringify({ type: "turn.completed" }));
`;
  fs.writeFileSync(params.scriptPath, script, {
    encoding: "utf-8",
    mode: 0o755,
  });
}

describe("Codex session title generator", () => {
  test("uses low-depth one-shot prompt and returns normalized title", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-codex-title-"));
    const scriptPath = path.join(root, "fake-codex-title.mjs");
    const callLogPath = path.join(root, "calls.json");
    createFakeCodexTitleScript({
      scriptPath,
      callLogPath,
      titleText: "支付超时排查与告警策略",
    });

    const generator = createCodexSessionTitleGenerator({
      command: scriptPath,
      args: ["exec", "{{prompt}}"],
    });
    if (!generator) {
      throw new Error("expected codex session title generator");
    }

    const title = await generator.generateTitle({
      sessionId: "s-title",
      agentId: "codex",
      firstUserPrompt: "帮我排查支付超时与重试告警",
    });

    expect(title).toBe("支付超时排查与告警策略");
    const args = JSON.parse(fs.readFileSync(callLogPath, "utf-8")) as string[];
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).not.toContain("resume");

    const prompt = args[args.length - 1] ?? "";
    expect(prompt).toContain("Thinking depth preference: low.");
    expect(prompt).toContain("one-shot title generation task");
    expect(prompt).toContain("帮我排查支付超时与重试告警");
  });
});
