import type { SkillRuntime } from "../core/skills.js";
import { InstructionSkill } from "../core/skills.js";
import { InMemoryMemoryBank, MemorySkill } from "../core/memory-skill.js";

export type SkillPresetResult = {
  memoryBank: InMemoryMemoryBank;
  memorySkill: MemorySkill;
};

export function registerDefaultSkills(runtime: SkillRuntime): SkillPresetResult {
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
      id: "cloudcode.infra.safe",
      description: "CloudCode should prioritize safe infra and rollback-minded plans.",
      appliesTo: ["cloudcode"],
      instruction: "优先给出可回滚、可观测的基础设施变更方案，并标注风险边界。",
    }),
  );

  runtime.register(
    new InstructionSkill({
      id: "cloudcode.cost.control",
      description: "CloudCode should consider runtime and cloud cost impact.",
      appliesTo: ["cloudcode"],
      instruction: "方案中应明确资源和成本影响，并优先选择轻量实现。",
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

  return {
    memoryBank,
    memorySkill,
  };
}
