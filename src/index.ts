import { CloudCodeAgentAdapter } from "./adapters/cloudcode.js";
import { ClaudeCodeAgentAdapter } from "./adapters/claudecode.js";
import { CodexAgentAdapter, createCodexCliBackendFromEnv } from "./adapters/codex.js";
import { AgentRegistry } from "./core/agent.js";
import { HookBus } from "./core/hooks.js";
import { ChatOrchestrator } from "./core/orchestrator.js";
import { InMemorySessionStore } from "./core/session.js";
import { SkillRuntime } from "./core/skills.js";
import { ReadabilityPolicy } from "./core/ux-policy.js";
import { registerDefaultSkills } from "./presets/skill-packs.js";

export * from "./core/types.js";
export * from "./core/agent.js";
export * from "./core/hooks.js";
export * from "./core/naming.js";
export * from "./core/session.js";
export * from "./core/skills.js";
export * from "./core/memory-skill.js";
export * from "./core/commands.js";
export * from "./core/orchestrator.js";
export * from "./adapters/backend.js";
export * from "./adapters/codex.js";
export * from "./adapters/cloudcode.js";
export * from "./adapters/claudecode.js";
export * from "./presets/skill-packs.js";

export function createDefaultOrchestrator(): ChatOrchestrator {
  const registry = new AgentRegistry();
  const hooks = new HookBus();
  const skills = new SkillRuntime();
  const sessions = new InMemorySessionStore();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });

  const codexCli = createCodexCliBackendFromEnv();
  registry.register(new CodexAgentAdapter(codexCli ? { backend: codexCli } : undefined));
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
