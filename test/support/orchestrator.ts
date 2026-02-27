import { ClaudeCodeAgentAdapter } from "../../src/adapters/claudecode";
import { CodexAgentAdapter, DeterministicCodexBackend } from "../../src/adapters/codex";
import { HookAgentBackend } from "../../src/adapters/backend";
import { AgentRegistry } from "../../src/core/agent";
import { HookBus } from "../../src/core/hooks";
import { ChatOrchestrator } from "../../src/core/orchestrator";
import { InMemorySessionStore } from "../../src/core/session";
import { SkillRuntime } from "../../src/core/skills";
import { ToolRuntime } from "../../src/core/tools";
import { ReadabilityPolicy } from "../../src/core/ux-policy";
import { registerDefaultSkills } from "../../src/presets/skill-packs";
import { registerDefaultTools } from "../../src/presets/tool-packs";

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
