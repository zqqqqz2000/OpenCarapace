import { describe, expect, test } from "bun:test";
import { ToolRuntime, type CommandTool } from "../../src/core/tools.js";

function makeTool(params: {
  id: string;
  name: string;
  aliases?: string[];
  description?: string;
  text?: string;
}): CommandTool {
  const base = {
    id: params.id,
    name: params.name,
    description: params.description ?? "test tool",
    execute: () => ({ text: params.text ?? "ok" }),
  };
  if (params.aliases) {
    return {
      ...base,
      aliases: params.aliases,
    };
  }
  return base;
}

describe("ToolRuntime", () => {
  test("registers and resolves tool aliases", () => {
    const runtime = new ToolRuntime();
    runtime.register(
      makeTool({
        id: "openclaw.skill.lookup",
        name: "skill",
        aliases: ["sk"],
        text: "skill ok",
      }),
    );

    const result = runtime.run("sk", {
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/sk hello",
      args: ["hello"],
      cwd: process.cwd(),
    });

    expect(result?.text).toBe("skill ok");
  });

  test("rejects malformed id and duplicate aliases", () => {
    const runtime = new ToolRuntime();

    expect(() =>
      runtime.register(
        makeTool({
          id: "bad",
          name: "grep",
        }),
      ),
    ).toThrow(/invalid tool id/i);

    runtime.register(
      makeTool({
        id: "openclaw.skill.lookup",
        name: "skill",
      }),
    );

    expect(() =>
      runtime.register(
        makeTool({
          id: "openclaw.other.tool",
          name: "other",
          aliases: ["skill"],
        }),
      ),
    ).toThrow(/duplicate tool alias/i);
  });
});
