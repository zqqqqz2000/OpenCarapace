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
  memoryBank: InMemoryMemoryBank | null;
  memorySkill: MemorySkill | null;
  openClawSkill: OpenClawCatalogSkill | null;
};

function normalizeStringList(items: string[] | undefined): string[] {
  if (!items || items.length === 0) {
    return [];
  }
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function resolveSkillPaths(config?: OpenCarapaceConfig): string[] {
  const configured = normalizeStringList(config?.skills?.paths);
  if (configured.length > 0) {
    return configured;
  }
  return [".opencarapace/skills"];
}

function resolveSkillsLoadMode(config?: OpenCarapaceConfig): "lazy" | "eager" {
  return config?.skills?.load_mode === "eager" ? "eager" : "lazy";
}

function resolveSkillsReloadMode(config?: OpenCarapaceConfig): "on_change" | "always" {
  return config?.skills?.reload === "always" ? "always" : "on_change";
}

function resolveMemoryMode(config?: OpenCarapaceConfig): "off" | "project" | "global" | "hybrid" {
  const mode = config?.memory?.mode;
  if (mode === "off" || mode === "project" || mode === "global" || mode === "hybrid") {
    return mode;
  }
  return "project";
}

function buildDirectorySkillProtocolInstruction(config?: OpenCarapaceConfig): string {
  const roots = resolveSkillPaths(config);
  const loadMode = resolveSkillsLoadMode(config);
  const reloadMode = resolveSkillsReloadMode(config);
  return [
    `Skill协议: roots=${roots.join(", ")}; load=${loadMode}; reload=${reloadMode}.`,
    "先读SKILL.md摘要，再按任务只读取相关skill全文。",
    "避免加载无关skill。",
  ].join("\n");
}

function buildFileMemoryProtocolInstruction(config?: OpenCarapaceConfig): string {
  const enabled = config?.memory?.enabled ?? true;
  if (!enabled) {
    return "Memory协议: memory=off，当前回合不读写memory目录。";
  }

  const mode = resolveMemoryMode(config);
  const projectRoot = config?.memory?.project_root?.trim() || ".opencarapace/memory/projects";
  const globalRoot = config?.memory?.global_root?.trim() || "~/.config/opencarapace/memory/global";

  const modeRule = (() => {
    if (mode === "off") {
      return "- 作用域：off（不读不写）。";
    }
    if (mode === "project") {
      return "- 作用域：project（仅项目记忆）。";
    }
    if (mode === "global") {
      return "- 作用域：global（全局共享记忆）。";
    }
    return "- 作用域：hybrid（读取 project+global，默认写 project）。";
  })();

  return [
    "Memory协议: 记忆是文件，不使用memory专用工具。",
    modeRule,
    `路径: project=${projectRoot}; global=${globalRoot}`,
    "需要历史时先读目录；仅写稳定且已确认、可复用信息；临时猜测不写。",
  ].join("\n");
}

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
  const legacySessionMemoryEnabled = options?.config?.memory?.legacy_session_skill === true;
  const memoryBank = legacySessionMemoryEnabled ? new InMemoryMemoryBank() : null;
  const memorySkill = memoryBank
    ? new MemorySkill(memoryBank, { appliesTo: "*" })
    : null;
  if (memorySkill) {
    runtime.register(memorySkill);
  }

  runtime.register(
    new InstructionSkill({
      id: "core.skills.directory.protocol",
      description: "Load skills from configured directories via scan+match protocol.",
      appliesTo: "*",
      instruction: buildDirectorySkillProtocolInstruction(options?.config),
    }),
  );

  runtime.register(
    new InstructionSkill({
      id: "core.memory.file.protocol",
      description: "Use file-only memory policy and scope rules.",
      appliesTo: "*",
      instruction: buildFileMemoryProtocolInstruction(options?.config),
    }),
  );

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
