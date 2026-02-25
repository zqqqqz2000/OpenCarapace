import { ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode.js";
import { CodexAgentAdapter, DeterministicCodexBackend } from "../../src/adapters/codex.js";
import { HookAgentBackend } from "../../src/adapters/backend.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";
import { registerDefaultSkills } from "../../src/presets/skill-packs.js";
import { registerDefaultTools } from "../../src/presets/tool-packs.js";

export function createDeterministicOrchestrator(): ChatOrchestrator {
  const registry = new AgentRegistry();
  const hooks = new HookBus();
  const skills = new SkillRuntime();
  const tools = new ToolRuntime();
  const sessions = new InMemorySessionStore();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });

  registry.register(new CodexAgentAdapter({ backend: new DeterministicCodexBackend() }));
  registry.register(
    new ClaudeCodeAgentAdapter(
      new HookAgentBackend(async () => ({
        finalText: "Claude Code deterministic test backend response.",
      })),
    ),
  );

  const skillPreset = registerDefaultSkills(skills);
  registerDefaultTools(tools, {
    workspaceRoot: process.cwd(),
    openClawSkill: skillPreset.openClawSkill,
  });

  return new ChatOrchestrator({
    registry,
    hooks,
    skillRuntime: skills,
    toolRuntime: tools,
    sessionStore: sessions,
    readabilityPolicy: readability,
    defaultAgentId: "codex",
  });
}
