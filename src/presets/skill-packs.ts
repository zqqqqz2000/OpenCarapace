import path from "node:path";
import type { SkillRuntime } from "../core/skills.js";
import { InstructionSkill } from "../core/skills.js";
import { InMemoryMemoryBank, MemorySkill } from "../core/memory-skill.js";
import type { OpenCarapaceConfig } from "../config/types.js";
import { expandHomePath } from "../config/path.js";
import {
  createOpenClawCatalogSkill,
  type OpenClawCatalogSkill,
} from "../integrations/openclaw-skills.js";

export type SkillPresetResult = {
  memoryBank: InMemoryMemoryBank;
  memorySkill: MemorySkill;
  openClawSkill: OpenClawCatalogSkill | null;
};

function resolveOpenClawRoots(config?: OpenCarapaceConfig): string[] | undefined {
  const roots = [] as string[];
  const openclawRoot = config?.skills?.openclaw_root?.trim();
  if (openclawRoot) {
    roots.push(path.resolve(expandHomePath(openclawRoot), "skills"));
  }
  const extra = config?.skills?.openclaw_skill_dirs ?? [];
  for (const item of extra) {
    const normalized = item?.trim();
    if (!normalized) {
      continue;
    }
    roots.push(path.resolve(expandHomePath(normalized)));
  }
  return roots.length > 0 ? roots : undefined;
}

export function registerDefaultSkills(
  runtime: SkillRuntime,
  options?: {
    config?: OpenCarapaceConfig;
  },
): SkillPresetResult {
  const memoryBank = new InMemoryMemoryBank();
  const memorySkill = new MemorySkill(memoryBank, { appliesTo: "*" });
  runtime.register(memorySkill);

  runtime.register(
    new InstructionSkill({
      id: "codex.progress.notifier",
      description: "Codex should provide short progress notifications in-flight.",
      appliesTo: ["codex"],
      instruction:
        "在执行过程中，优先使用简短进度提示（1 句话）向用户同步阶段状态，避免长段推理外泄。",
    }),
  );

  runtime.register(
    new InstructionSkill({
      id: "codex.readable.final",
      description: "Codex final result must be short and readable.",
      appliesTo: ["codex"],
      instruction: "最终答复保持短、清晰、可执行，优先使用分点，不要堆叠冗长段落。",
    }),
  );

  runtime.register(
    new InstructionSkill({
      id: "claude.refactor.guide",
      description: "Claude Code should present refactor path with risk checkpoints.",
      appliesTo: ["claude-code"],
      instruction: "重构任务必须给出阶段拆分和回归检查点，先稳后快。",
    }),
  );

  runtime.register(
    new InstructionSkill({
      id: "claude.reasoning.boundary",
      description: "Claude Code should avoid overlong deliberation in user-visible output.",
      appliesTo: ["claude-code"],
      instruction: "输出中避免展开过长思考过程，保留结论、依据和下一步即可。",
    }),
  );

  const openClawEnabled = options?.config?.skills?.enable_openclaw_catalog ?? true;
  const openClawParams = {
    appliesTo: "*" as const,
    allowEnvDefaults: options?.config ? false : true,
    maxSelectedSkills: Math.max(
      1,
      options?.config?.skills?.openclaw_max_selected_skills ?? 2,
    ),
    maxSnippetChars: Math.max(
      240,
      options?.config?.skills?.openclaw_max_snippet_chars ?? 900,
    ),
  } as {
    appliesTo: "*";
    roots?: string[];
    allowEnvDefaults?: boolean;
    maxSelectedSkills: number;
    maxSnippetChars: number;
  };
  const roots = resolveOpenClawRoots(options?.config);
  if (roots) {
    openClawParams.roots = roots;
  }
  const openClawSkill = openClawEnabled
    ? createOpenClawCatalogSkill(openClawParams)
    : null;
  if (openClawSkill) {
    runtime.register(openClawSkill);
  }

  return {
    memoryBank,
    memorySkill,
    openClawSkill,
  };
}
