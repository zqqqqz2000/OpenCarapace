import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../../src/core/agent.js";
import { CodexAgentAdapter } from "../../src/adapters/codex.js";
import { CloudCodeAgentAdapter } from "../../src/adapters/cloudcode.js";

describe("AgentRegistry", () => {
  test("register and resolve adapters", () => {
    const registry = new AgentRegistry();
    registry.register(new CodexAgentAdapter());
    registry.register(new CloudCodeAgentAdapter());

    expect(registry.get("codex")?.displayName).toBe("Codex");
    expect(registry.get("cloudcode")?.displayName).toBe("CloudCode");
    expect(registry.list().length).toBe(2);
  });

  test("throws when adapter is missing", () => {
    const registry = new AgentRegistry();
    expect(() => registry.require("codex")).toThrow(/not found/i);
  });
});
