import { ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode.js";
import { CloudCodeAgentAdapter } from "../../src/adapters/cloudcode.js";
import { CodexAgentAdapter, DeterministicCodexBackend } from "../../src/adapters/codex.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";
import { registerDefaultSkills } from "../../src/presets/skill-packs.js";

export function createDeterministicOrchestrator(): ChatOrchestrator {
  const registry = new AgentRegistry();
  const hooks = new HookBus();
  const skills = new SkillRuntime();
  const sessions = new InMemorySessionStore();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });

  registry.register(new CodexAgentAdapter({ backend: new DeterministicCodexBackend() }));
  registry.register(new CloudCodeAgentAdapter());
  registry.register(new ClaudeCodeAgentAdapter());

  registerDefaultSkills(skills);

  return new ChatOrchestrator({
    registry,
    hooks,
    skillRuntime: skills,
    sessionStore: sessions,
    readabilityPolicy: readability,
    defaultAgentId: "codex",
  });
}
