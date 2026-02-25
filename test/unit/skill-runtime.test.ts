import { describe, expect, test } from "bun:test";
import { SkillRuntime, InstructionSkill } from "../../src/core/skills.js";
import { MemorySkill, InMemoryMemoryBank } from "../../src/core/memory-skill.js";
import type { AgentTurnRequest } from "../../src/core/types.js";

function request(prompt: string): AgentTurnRequest {
  return {
    agentId: "codex",
    sessionId: "session-1",
    prompt,
    messages: [{ role: "user", content: prompt, createdAt: Date.now() }],
    systemDirectives: [],
    skills: [],
  };
}

describe("SkillRuntime", () => {
  test("applies only matching agent skills", async () => {
    const runtime = new SkillRuntime();
    runtime.register(
      new InstructionSkill({
        id: "codex.runtime.rule",
        description: "codex rule",
        instruction: "for codex only",
        appliesTo: ["codex"],
      }),
    );
    runtime.register(
      new InstructionSkill({
        id: "claude.runtime.rule",
        description: "claude rule",
        instruction: "for claude only",
        appliesTo: ["claude-code"],
      }),
    );

    const skills = runtime.listApplicable("codex");
    expect(skills.map((s) => s.id)).toEqual(["codex.runtime.rule"]);

    const patch = await runtime.runBeforeTurn(skills, request("hello"));
    expect(patch.systemDirectives).toContain("for codex only");
  });

  test("memory skill injects relevant memory", () => {
    const bank = new InMemoryMemoryBank();
    bank.append({
      sessionId: "session-1",
      at: Date.now(),
      userText: "修复登录超时",
      assistantText: "已调整 token 校验与重试",
    });

    const skill = new MemorySkill(bank);
    const patch = skill.beforeTurn({ request: request("登录超时问题还在吗") });
    expect(patch?.systemDirectives?.join("\n")).toContain("修复登录超时");
  });

  test("rejects invalid skill id and duplicate ids", () => {
    const runtime = new SkillRuntime();

    expect(() =>
      runtime.register(
        new InstructionSkill({
          id: "invalid",
          description: "bad",
          instruction: "bad",
          appliesTo: "*",
        }),
      ),
    ).toThrow(/invalid skill id/i);

    runtime.register(
      new InstructionSkill({
        id: "core.test.rule",
        description: "ok",
        instruction: "ok",
        appliesTo: "*",
      }),
    );

    expect(() =>
      runtime.register(
        new InstructionSkill({
          id: "core.test.rule",
          description: "dup",
          instruction: "dup",
          appliesTo: "*",
        }),
      ),
    ).toThrow(/duplicate skill id/i);
  });
});
