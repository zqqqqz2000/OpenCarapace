import { describe, expect, test } from "bun:test";
import { HookBus } from "../../src/core/hooks";

describe("HookBus", () => {
  test("rejects invalid id and duplicate ids", () => {
    const hooks = new HookBus();

    expect(() => hooks.register({ id: "invalid" })).toThrow(/invalid hook id/i);

    hooks.register({ id: "core.turn.audit" });
    expect(() => hooks.register({ id: "core.turn.audit" })).toThrow(/duplicate hook id/i);
  });

  test("merges beforeTurn patches in registration order", async () => {
    const hooks = new HookBus();

    hooks.register({
      id: "core.turn.first",
      beforeTurn: () => ({
        systemDirectives: ["first"],
        metadata: { a: 1 },
      }),
    });
    hooks.register({
      id: "core.turn.second",
      beforeTurn: () => ({
        systemDirectives: ["second"],
        metadata: { b: 2 },
      }),
    });

    const patch = await hooks.runBeforeTurn({
      request: {
        agentId: "codex",
        sessionId: "s",
        prompt: "hello",
        messages: [],
        systemDirectives: [],
        skills: [],
      },
    });

    expect(patch.systemDirectives).toEqual(["first", "second"]);
    expect(patch.metadata).toEqual({ a: 1, b: 2 });
  });
});
