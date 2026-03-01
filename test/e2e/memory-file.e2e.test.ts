import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CodexAgentAdapter } from "../../src/adapters/codex.js";
import { HookAgentBackend, type BackendRunRequest } from "../../src/adapters/backend.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { HookBus } from "../../src/core/hooks.js";
import { ChatOrchestrator } from "../../src/core/orchestrator.js";
import { InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { ReadabilityPolicy } from "../../src/core/ux-policy.js";
import type { OpenCarapaceConfig } from "../../src/config/types.js";
import { registerDefaultSkills } from "../../src/presets/skill-packs.js";
import { registerDefaultTools } from "../../src/presets/tool-packs.js";

type MemoryMode = "off" | "project" | "global" | "hybrid";

type MemoryProtocol = {
  mode: MemoryMode;
  projectRoot: string;
  globalRoot: string;
};

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractUserPreference(prompt: string): string | undefined {
  const clauses = splitSentences(prompt);
  for (const clause of clauses) {
    if (/^(我的偏好是|偏好[:：]|我喜欢|我习惯|请记住)/.test(clause)) {
      return clause;
    }
  }
  return undefined;
}

function isRecallPrompt(prompt: string): boolean {
  return /(偏好|喜欢|习惯|按我的|之前说过|记得我)/.test(prompt);
}

function resolveMode(directives: string): MemoryMode {
  if (directives.includes("memory=off") || directives.includes("作用域：off")) {
    return "off";
  }
  if (directives.includes("作用域：global")) {
    return "global";
  }
  if (directives.includes("作用域：hybrid")) {
    return "hybrid";
  }
  return "project";
}

function resolvePaths(directives: string): { projectRoot: string; globalRoot: string } {
  const line = directives
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("路径:"));
  if (!line) {
    return {
      projectRoot: ".opencarapace/memory/projects",
      globalRoot: "~/.config/opencarapace/memory/global",
    };
  }
  const match = line.match(/project=(.+?);\s*global=(.+)$/);
  if (!match) {
    return {
      projectRoot: ".opencarapace/memory/projects",
      globalRoot: "~/.config/opencarapace/memory/global",
    };
  }
  return {
    projectRoot: (match[1] ?? ".opencarapace/memory/projects").trim(),
    globalRoot: (match[2] ?? "~/.config/opencarapace/memory/global").trim(),
  };
}

function resolveMemoryProtocol(request: BackendRunRequest): MemoryProtocol {
  const directives = request.systemDirectives.join("\n");
  const paths = resolvePaths(directives);
  return {
    mode: resolveMode(directives),
    projectRoot: paths.projectRoot,
    globalRoot: paths.globalRoot,
  };
}

function projectPreferenceFile(root: string, sessionId: string): string {
  return path.join(root, safeSessionId(sessionId), "preferences.md");
}

function globalPreferenceFile(root: string): string {
  return path.join(root, "preferences.md");
}

function readPreferences(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendPreference(filePath: string, preference: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = readPreferences(filePath);
  if (lines.includes(preference)) {
    return;
  }
  lines.push(preference);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

function resolveLatestPreference(preferences: string[]): string | undefined {
  if (preferences.length === 0) {
    return undefined;
  }
  return preferences[preferences.length - 1];
}

class ProtocolAwareMemoryModel {
  readonly requests: BackendRunRequest[] = [];

  async run(request: BackendRunRequest): Promise<{ finalText: string }> {
    this.requests.push(request);
    const protocol = resolveMemoryProtocol(request);
    const preference = extractUserPreference(request.prompt);

    if (protocol.mode !== "off" && preference) {
      if (protocol.mode === "global") {
        appendPreference(globalPreferenceFile(protocol.globalRoot), preference);
      } else {
        appendPreference(projectPreferenceFile(protocol.projectRoot, request.sessionId), preference);
      }
    }

    if (!isRecallPrompt(request.prompt)) {
      return { finalText: preference ? `已记录偏好：${preference}` : "已处理当前请求。" };
    }

    if (protocol.mode === "off") {
      return { finalText: "未找到用户偏好（memory 关闭）。" };
    }

    let preferences: string[] = [];
    if (protocol.mode === "project") {
      preferences = readPreferences(projectPreferenceFile(protocol.projectRoot, request.sessionId));
    } else if (protocol.mode === "global") {
      preferences = readPreferences(globalPreferenceFile(protocol.globalRoot));
    } else {
      preferences = readPreferences(projectPreferenceFile(protocol.projectRoot, request.sessionId));
      if (preferences.length === 0) {
        preferences = readPreferences(globalPreferenceFile(protocol.globalRoot));
      }
    }

    if (preferences.length === 0) {
      return { finalText: "未找到用户偏好。" };
    }
    return { finalText: `已读取用户偏好：${resolveLatestPreference(preferences)}` };
  }
}

function createMemoryE2EOrchestrator(params: {
  enabled?: boolean;
  mode: MemoryMode;
  projectRoot: string;
  globalRoot: string;
}): { orchestrator: ChatOrchestrator; model: ProtocolAwareMemoryModel } {
  const model = new ProtocolAwareMemoryModel();
  const registry = new AgentRegistry();
  const hooks = new HookBus();
  const skills = new SkillRuntime();
  const tools = new ToolRuntime();
  const sessions = new InMemorySessionStore();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });

  registry.register(
    new CodexAgentAdapter({
      backend: new HookAgentBackend(async (request) => {
        return await model.run(request);
      }),
    }),
  );

  const config: OpenCarapaceConfig = {
    skills: {
      enable_openclaw_catalog: false,
    },
    memory: {
      enabled: params.enabled ?? true,
      mode: params.mode,
      project_root: params.projectRoot,
      global_root: params.globalRoot,
    },
  };
  const skillPreset = registerDefaultSkills(skills, { config });
  registerDefaultTools(tools, {
    workspaceRoot: process.cwd(),
    openClawSkill: skillPreset.openClawSkill,
  });

  return {
    model,
    orchestrator: new ChatOrchestrator({
      registry,
      hooks,
      skillRuntime: skills,
      toolRuntime: tools,
      sessionStore: sessions,
      readabilityPolicy: readability,
      defaultAgentId: "codex",
    }),
  };
}

function makeRoots(prefix: string): { projectRoot: string; globalRoot: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), `open-carapace-${prefix}-`));
  return {
    projectRoot: path.join(base, ".opencarapace", "memory", "projects"),
    globalRoot: path.join(base, ".opencarapace", "memory", "global"),
  };
}

describe("E2E file-memory protocol", () => {
  const preferencePromptVariants = [
    "我的偏好是：回答尽量简短。",
    "偏好：先给结论再给步骤。",
    "我喜欢分点回答，重点放在可执行项。",
    "我习惯先看风险，再看实现。",
    "请记住：我偏好中文输出。",
  ];
  const recallPromptVariants = [
    "请按我的偏好回复。",
    "你记得我的偏好吗？",
    "按我之前说过的习惯来回答。",
    "你还记得我喜欢什么表达方式吗？",
  ];

  test("injects concise memory protocol every turn", async () => {
    const roots = makeRoots("memory-e2e-inject");
    const { orchestrator, model } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-inject-1",
      input: "你好，先确认协议是否存在。",
    });
    await orchestrator.chat({
      sessionId: "e2e-inject-1",
      input: "再来一轮，确认每轮都注入。",
    });

    const firstDirectives = model.requests[0]?.systemDirectives ?? [];
    const secondDirectives = model.requests[1]?.systemDirectives ?? [];
    const skillDirective = firstDirectives.find((line) => line.includes("Skill协议:")) ?? "";
    const memoryDirective = firstDirectives.find((line) => line.includes("Memory协议:")) ?? "";
    expect(skillDirective.length).toBeGreaterThan(0);
    expect(memoryDirective.length).toBeGreaterThan(0);
    expect(secondDirectives.some((line) => line.includes("Skill协议:"))).toBeTrue();
    expect(secondDirectives.some((line) => line.includes("Memory协议:"))).toBeTrue();
    expect(skillDirective.length).toBeLessThanOrEqual(220);
    expect(memoryDirective.split("\n").length).toBeLessThanOrEqual(4);
    expect(memoryDirective).toContain("由LLM通过skill主动读写");
    expect(memoryDirective).toContain("路径:");
    expect(memoryDirective).toContain("core");
    expect(memoryDirective).toContain("daily");
    expect(memoryDirective).toContain("先读目录再读core");
    expect(memoryDirective).toContain("仅写稳定且已确认");
  });

  test("mode=off does not persist or recall preferences", async () => {
    const roots = makeRoots("memory-e2e-off");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "off",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-off-1",
      input: "我的偏好是：回答尽量简短。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-off-1",
      input: "请按我的偏好回复，并告诉我你记得什么。",
    });

    expect(recall.finalText).toContain("memory 关闭");
    expect(fs.existsSync(roots.projectRoot)).toBeFalse();
    expect(fs.existsSync(roots.globalRoot)).toBeFalse();
  });

  test("mode=project supports multi-turn preference recall in same session", async () => {
    const roots = makeRoots("memory-e2e-project");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-project-1",
      input: "我的偏好是：用中文、分点、简短回答。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-project-1",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("已读取用户偏好");
    expect(recall.finalText).toContain("分点");
  });

  for (const [index, prompt] of preferencePromptVariants.entries()) {
    test(`mode=project supports preference prompt variant #${index + 1}`, async () => {
      const roots = makeRoots(`memory-e2e-pref-variant-${index + 1}`);
      const { orchestrator } = createMemoryE2EOrchestrator({
        mode: "project",
        projectRoot: roots.projectRoot,
        globalRoot: roots.globalRoot,
      });

      await orchestrator.chat({
        sessionId: `e2e-pref-variant-${index + 1}`,
        input: prompt,
      });
      const recall = await orchestrator.chat({
        sessionId: `e2e-pref-variant-${index + 1}`,
        input: "请按我的偏好回复。",
      });

      expect(recall.finalText).toContain("已读取用户偏好");
    });
  }

  for (const [index, recallPrompt] of recallPromptVariants.entries()) {
    test(`mode=project supports recall prompt variant #${index + 1}`, async () => {
      const roots = makeRoots(`memory-e2e-recall-variant-${index + 1}`);
      const { orchestrator } = createMemoryE2EOrchestrator({
        mode: "project",
        projectRoot: roots.projectRoot,
        globalRoot: roots.globalRoot,
      });

      await orchestrator.chat({
        sessionId: `e2e-recall-variant-${index + 1}`,
        input: "我的偏好是：回答里带一个明确下一步。",
      });
      const recall = await orchestrator.chat({
        sessionId: `e2e-recall-variant-${index + 1}`,
        input: recallPrompt,
      });

      expect(recall.finalText).toContain("明确下一步");
    });
  }

  test("mode=project keeps latest preference in multi-turn updates", async () => {
    const roots = makeRoots("memory-e2e-project-latest");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-project-latest-1",
      input: "我的偏好是：先给结论。",
    });
    await orchestrator.chat({
      sessionId: "e2e-project-latest-1",
      input: "我的偏好是：先给风险，再给结论。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-project-latest-1",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("先给风险");
  });

  test("mode=project deduplicates same preference", async () => {
    const roots = makeRoots("memory-e2e-project-dedupe");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-project-dedupe-1",
      input: "我的偏好是：回答尽量简短。",
    });
    await orchestrator.chat({
      sessionId: "e2e-project-dedupe-1",
      input: "我的偏好是：回答尽量简短。",
    });

    const projectFile = projectPreferenceFile(roots.projectRoot, "e2e-project-dedupe-1");
    const lines = readPreferences(projectFile);
    expect(lines.length).toBe(1);
  });

  test("mode=project isolates memory across sessions", async () => {
    const roots = makeRoots("memory-e2e-project-isolated");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-project-a",
      input: "我的偏好是：偏向先给结论。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-project-b",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("未找到用户偏好");
  });

  test("mode=global shares preference across sessions", async () => {
    const roots = makeRoots("memory-e2e-global");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "global",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-global-a",
      input: "我的偏好是：先给风险，再给方案。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-global-b",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("先给风险");
  });

  test("mode=global shares preference across many sessions", async () => {
    const roots = makeRoots("memory-e2e-global-many");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "global",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-global-many-a",
      input: "我的偏好是：避免长段落。",
    });
    const recallB = await orchestrator.chat({
      sessionId: "e2e-global-many-b",
      input: "请按我的偏好回复。",
    });
    const recallC = await orchestrator.chat({
      sessionId: "e2e-global-many-c",
      input: "你记得我的偏好吗？",
    });

    expect(recallB.finalText).toContain("避免长段落");
    expect(recallC.finalText).toContain("避免长段落");
  });

  test("mode=hybrid reads global fallback and writes to project by default", async () => {
    const roots = makeRoots("memory-e2e-hybrid");
    fs.mkdirSync(roots.globalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(roots.globalRoot, "preferences.md"),
      "我的偏好是：保持回复简短。\n",
      "utf-8",
    );

    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "hybrid",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    const recallFromGlobal = await orchestrator.chat({
      sessionId: "e2e-hybrid-1",
      input: "请按我的偏好回复。",
    });
    expect(recallFromGlobal.finalText).toContain("保持回复简短");

    await orchestrator.chat({
      sessionId: "e2e-hybrid-1",
      input: "我的偏好是：输出里带一个下一步建议。",
    });

    const projectFile = projectPreferenceFile(roots.projectRoot, "e2e-hybrid-1");
    const globalFile = globalPreferenceFile(roots.globalRoot);
    expect(readPreferences(projectFile).join("\n")).toContain("下一步建议");
    expect(readPreferences(globalFile).join("\n")).not.toContain("下一步建议");
  });

  test("mode=hybrid prefers project preference when both project and global exist", async () => {
    const roots = makeRoots("memory-e2e-hybrid-priority");
    fs.mkdirSync(roots.globalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(roots.globalRoot, "preferences.md"),
      "我的偏好是：全局偏好-更简短。\n",
      "utf-8",
    );

    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "hybrid",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-hybrid-priority-1",
      input: "我的偏好是：项目偏好-先结论后步骤。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-hybrid-priority-1",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("项目偏好-先结论后步骤");
    expect(recall.finalText).not.toContain("全局偏好-更简短");
  });

  test("memory.enabled=false behaves like off", async () => {
    const roots = makeRoots("memory-e2e-disabled");
    const { orchestrator } = createMemoryE2EOrchestrator({
      enabled: false,
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-disabled-1",
      input: "我的偏好是：回答要有编号。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-disabled-1",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("memory 关闭");
  });

  test("non-preference prompt does not create preference memory", async () => {
    const roots = makeRoots("memory-e2e-no-pref");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-no-pref-1",
      input: "今天我主要在排查超时，不需要记录偏好。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-no-pref-1",
      input: "请按我的偏好回复。",
    });

    expect(recall.finalText).toContain("未找到用户偏好");
  });

  test("stores user-related preference only, ignores unrelated details", async () => {
    const roots = makeRoots("memory-e2e-user-only");
    const { orchestrator } = createMemoryE2EOrchestrator({
      mode: "project",
      projectRoot: roots.projectRoot,
      globalRoot: roots.globalRoot,
    });

    await orchestrator.chat({
      sessionId: "e2e-user-only-1",
      input: "我的偏好是：回答里先写结论。另外我今天看了3小时日志。",
    });
    const recall = await orchestrator.chat({
      sessionId: "e2e-user-only-1",
      input: "你记得我的偏好吗？",
    });

    expect(recall.finalText).toContain("先写结论");
    expect(recall.finalText).not.toContain("3小时日志");
  });
});
