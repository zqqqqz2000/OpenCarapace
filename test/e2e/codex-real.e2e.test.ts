import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createDefaultOrchestrator } from "../../src/index.js";
import type { ChatOrchestrator } from "../../src/core/orchestrator.js";
import type { OpenCarapaceConfig } from "../../src/config/types.js";

describe("E2E real codex (optional)", () => {
  const TEST_TIMEOUT_MS = 120_000;
  const runner = process.env.E2E_REAL_CODEX === "1" ? test : test.skip;

  type MemoryMode = "off" | "project" | "global" | "hybrid";
  type MemoryFixture = {
    baseDir: string;
    projectRoot: string;
    globalRoot: string;
  };

  function makeMemoryFixture(prefix: string): MemoryFixture {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), `open-carapace-real-memory-${prefix}-`));
    const baseDir = fs.realpathSync.native(tempDir);
    const projectRoot = path.join(baseDir, "memory", "projects");
    const globalRoot = path.join(baseDir, "memory", "global");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });
    return {
      baseDir,
      projectRoot,
      globalRoot,
    };
  }

  function fileContent(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf-8");
  }

  function countFiles(rootDir: string): number {
    if (!fs.existsSync(rootDir)) {
      return 0;
    }
    let total = 0;
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        total += 1;
      }
    }
    return total;
  }

  async function runCodexTurn(params: {
    orchestrator: ChatOrchestrator;
    sessionId: string;
    input: string;
    fixture?: MemoryFixture;
  }) {
    const metadata = params.fixture
      ? {
          project_root_dir: params.fixture.baseDir,
        }
      : undefined;
    return await params.orchestrator.chat({
      agentId: "codex",
      sessionId: params.sessionId,
      input: params.input,
      metadata,
    });
  }

  async function ensureWritableSandbox(params: {
    orchestrator: ChatOrchestrator;
    sessionId: string;
    fixture: MemoryFixture;
  }): Promise<void> {
    const result = await runCodexTurn({
      orchestrator: params.orchestrator,
      sessionId: params.sessionId,
      fixture: params.fixture,
      input: "/sandbox workspace-write",
    });
    expect(result.finalText).toContain("Sandbox mode set.");
  }

  function createRealCodexOrchestrator(params?: {
    legacySessionSkill?: boolean;
    memoryMode?: MemoryMode;
    projectRoot?: string;
    globalRoot?: string;
    workspaceRoot?: string;
  }): ChatOrchestrator {
    const command = process.env.CODEX_CLI_COMMAND?.trim();
    if (!command) {
      throw new Error("E2E_REAL_CODEX=1 but CODEX_CLI_COMMAND is missing");
    }
    const args = (process.env.CODEX_CLI_ARGS ?? "exec {{prompt}}")
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);

    const config: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "codex",
      },
      agents: {
        codex: {
          enabled: true,
          cli_command: command,
          cli_args: args,
        },
        claude_code: {
          enabled: false,
        },
      },
      skills: {
        enable_openclaw_catalog: false,
      },
      memory: {
        enabled: true,
        mode: params?.memoryMode ?? "project",
        project_root: params?.projectRoot,
        global_root: params?.globalRoot,
        legacy_session_skill: params?.legacySessionSkill === true,
      },
    };
    if (params?.workspaceRoot) {
      config.runtime = {
        ...(config.runtime ?? {}),
        workspace_root: params.workspaceRoot,
      };
    }

    return createDefaultOrchestrator({ config });
  }

  runner(
    "returns non-empty output and expected event timeline",
    async () => {
      const orchestrator = createRealCodexOrchestrator();
      const result = await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-timeline",
        input: "给我一个简短的测试计划，最多 5 条。",
      });

      expect(result.finalText.length).toBeGreaterThan(0);
      expect(result.events.some((event) => event.type === "result")).toBeTrue();
      expect(result.events.some((event) => event.type === "delta")).toBeTrue();
      expect(
        result.events.some(
          (event) =>
            event.type === "command" &&
            (event.command.name === "notify" || event.command.name === "progress"),
        ),
      ).toBeTrue();

      const phases = result.events
        .filter((event): event is Extract<typeof event, { type: "status" }> => event.type === "status")
        .map((event) => event.phase);
      expect(phases).toContain("queued");
      expect(phases).toContain("running");
      expect(phases).toContain("thinking");
      expect(phases).toContain("finalizing");
      expect(phases).toContain("completed");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "keeps final output readable under policy limits",
    async () => {
      const orchestrator = createRealCodexOrchestrator();
      const result = await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-readable",
        input:
          "请给一份发布计划，包含背景、步骤、风险、回滚、验证、沟通，尽量完整，但最终输出要清晰可读。",
      });

      expect(result.finalText.length).toBeGreaterThan(0);
      expect(result.finalText.length).toBeLessThanOrEqual(800);
      expect(result.finalText.split("\n").length).toBeLessThanOrEqual(12);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "supports multi-turn session continuity with real codex",
    async () => {
      const orchestrator = createRealCodexOrchestrator();

      const first = await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-session",
        input: "我们要修复登录超时，请先给一个简短方案。",
      });
      expect(first.finalText.length).toBeGreaterThan(0);

      const second = await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-session",
        input: "在你上个方案上，补一个最小验证步骤。",
      });
      expect(second.finalText.length).toBeGreaterThan(0);
      expect(second.agentId).toBe("codex");

      const snapshot = orchestrator.sessions.snapshot("real-codex-e2e-session");
      expect(snapshot?.agentId).toBe("codex");
      expect(snapshot?.messages.length).toBe(4);
      expect(snapshot?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "works with memory command after real codex turns",
    async () => {
      const orchestrator = createRealCodexOrchestrator({
        legacySessionSkill: true,
      });

      await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-memory",
        input: "请给一条关于缓存击穿的简短处理建议。",
      });
      await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-memory",
        input: "补一条对应的监控建议。",
      });

      const memory = await runCodexTurn({
        orchestrator,
        sessionId: "real-codex-e2e-memory",
        input: "/memory show 2",
      });
      expect(memory.finalText).toContain("Memory (latest");
      expect(memory.finalText).toContain("user:");
      expect(memory.finalText).toContain("assistant:");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "project mode: writes and recalls preference from project memory file",
    async () => {
      const fixture = makeMemoryFixture("real-project-basic");
      const sessionId = "real-memory-project-1";
      const projectFile = path.join(fixture.projectRoot, sessionId, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "project",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId, fixture });

      const write = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- (grep -qxF "我的偏好是：回答简短并分点。" "${projectFile}" 2>/dev/null) || printf '%s\\n' "我的偏好是：回答简短并分点。" >> "${projectFile}"`,
          "完成后仅输出 REAL_PROJECT_WRITE_OK",
        ].join("\n"),
      });
      expect(write.finalText).toContain("REAL_PROJECT_WRITE_OK");
      expect(fs.existsSync(projectFile)).toBeTrue();
      expect(fileContent(projectFile)).toContain("回答简短并分点");

      const recall = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          `读取文件 ${projectFile} 的第一条偏好。`,
          "输出格式：REAL_PROJECT_RECALL: <偏好内容>",
          "若文件不存在，输出：REAL_PROJECT_RECALL: MISSING",
        ].join("\n"),
      });
      expect(recall.finalText).toContain("REAL_PROJECT_RECALL");
      expect(recall.finalText).toContain("回答简短并分点");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "project mode: isolates preferences between sessions",
    async () => {
      const fixture = makeMemoryFixture("real-project-isolated");
      const sessionA = "real-memory-project-a";
      const sessionB = "real-memory-project-b";
      const fileA = path.join(fixture.projectRoot, sessionA, "preferences.md");
      const fileB = path.join(fixture.projectRoot, sessionB, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "project",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId: sessionA, fixture });

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: sessionA,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${fileA}")"`,
          `- (grep -qxF "我的偏好是：先结论后步骤。" "${fileA}" 2>/dev/null) || printf '%s\\n' "我的偏好是：先结论后步骤。" >> "${fileA}"`,
          "完成后仅输出 REAL_PROJECT_A_WRITE_OK",
        ].join("\n"),
      });

      const recallB = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: sessionB,
        input: [
          `只读取 ${fileB}，如果不存在就回复 REAL_PROJECT_ISOLATION_EMPTY。`,
          "不要读取其他文件。",
        ].join("\n"),
      });
      expect(recallB.finalText).toContain("REAL_PROJECT_ISOLATION_EMPTY");
      expect(fs.existsSync(fileB)).toBeFalse();
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "global mode: shares preference across sessions",
    async () => {
      const fixture = makeMemoryFixture("real-global-shared");
      const globalFile = path.join(fixture.globalRoot, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "global",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId: "real-global-a", fixture });

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: "real-global-a",
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${globalFile}")"`,
          `- (grep -qxF "我的偏好是：先风险后方案。" "${globalFile}" 2>/dev/null) || printf '%s\\n' "我的偏好是：先风险后方案。" >> "${globalFile}"`,
          "完成后仅输出 REAL_GLOBAL_WRITE_OK",
        ].join("\n"),
      });

      const recall = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: "real-global-b",
        input: `读取 ${globalFile} 并回复 REAL_GLOBAL_RECALL: <偏好内容>。`,
      });
      expect(recall.finalText).toContain("REAL_GLOBAL_RECALL");
      expect(recall.finalText).toContain("先风险后方案");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "hybrid mode: falls back to global and then prefers project override",
    async () => {
      const fixture = makeMemoryFixture("real-hybrid");
      const sessionId = "real-hybrid-1";
      const projectFile = path.join(fixture.projectRoot, sessionId, "preferences.md");
      const globalFile = path.join(fixture.globalRoot, "preferences.md");
      fs.writeFileSync(globalFile, "我的偏好是：全局-简短回复。\n", "utf-8");

      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "hybrid",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId, fixture });

      const fallback = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          `按hybrid策略读取偏好：先查 ${projectFile}，若不存在再查 ${globalFile}。`,
          "用 REAL_HYBRID_FALLBACK: 前缀回复结果。",
        ].join("\n"),
      });
      expect(fallback.finalText).toContain("REAL_HYBRID_FALLBACK");
      expect(fallback.finalText).toContain("全局-简短回复");

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- (grep -qxF "我的偏好是：项目-先给结论。" "${projectFile}" 2>/dev/null) || printf '%s\\n' "我的偏好是：项目-先给结论。" >> "${projectFile}"`,
          "完成后仅输出 REAL_HYBRID_PROJECT_WRITE_OK",
        ].join("\n"),
      });

      const projectFirst = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          `再次按hybrid策略读取：优先 ${projectFile}，其次 ${globalFile}。`,
          "用 REAL_HYBRID_PROJECT_FIRST: 前缀回复。",
        ].join("\n"),
      });
      expect(projectFirst.finalText).toContain("REAL_HYBRID_PROJECT_FIRST");
      expect(projectFirst.finalText).toContain("项目-先给结论");
      expect(projectFirst.finalText).not.toContain("全局-简短回复");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "off mode: should not write any memory files",
    async () => {
      const fixture = makeMemoryFixture("real-off");
      const projectFile = path.join(fixture.projectRoot, "real-off-1", "preferences.md");
      const globalFile = path.join(fixture.globalRoot, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "off",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });

      const result = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: "real-off-1",
        input: [
          "先检查Memory协议：如果是off，不要创建任何memory文件。",
          `禁止写入 ${projectFile} 和 ${globalFile}。`,
          "满足时回复 REAL_OFF_NO_WRITE。",
        ].join("\n"),
      });

      expect(result.finalText).toContain("REAL_OFF_NO_WRITE");
      expect(countFiles(fixture.projectRoot)).toBe(0);
      expect(countFiles(fixture.globalRoot)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "project mode: keeps user preference only and excludes unrelated details",
    async () => {
      const fixture = makeMemoryFixture("real-user-only");
      const sessionId = "real-user-only-1";
      const projectFile = path.join(fixture.projectRoot, sessionId, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "project",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId, fixture });

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "请只记录用户偏好，不要记录无关信息。",
          "偏好：回答里先写结论。",
          "无关信息：今天看了3小时日志。",
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- (grep -qxF "偏好：回答里先写结论。" "${projectFile}" 2>/dev/null) || printf '%s\\n' "偏好：回答里先写结论。" >> "${projectFile}"`,
          "完成后仅输出 REAL_USER_ONLY_WRITE_OK",
        ].join("\n"),
      });

      const text = fileContent(projectFile);
      expect(text).toContain("先写结论");
      expect(text).not.toContain("3小时日志");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "project mode: updates preference and recalls latest one",
    async () => {
      const fixture = makeMemoryFixture("real-latest");
      const sessionId = "real-latest-1";
      const projectFile = path.join(fixture.projectRoot, sessionId, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "project",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId, fixture });

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- printf '%s\\n' "我的偏好是：先结论。" >> "${projectFile}"`,
          "完成后仅输出 REAL_LATEST_1_OK",
        ].join("\n"),
      });
      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- printf '%s\\n' "我的偏好是：先风险后结论。" >> "${projectFile}"`,
          "完成后仅输出 REAL_LATEST_2_OK",
        ].join("\n"),
      });

      const recall = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: `读取 ${projectFile} 的最后一条偏好并回复 REAL_LATEST_RECALL: <内容>。`,
      });
      expect(recall.finalText).toContain("REAL_LATEST_RECALL");
      expect(recall.finalText).toContain("先风险后结论");
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "project mode: deduplicates identical preference entries",
    async () => {
      const fixture = makeMemoryFixture("real-dedupe");
      const sessionId = "real-dedupe-1";
      const projectFile = path.join(fixture.projectRoot, sessionId, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "project",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId, fixture });

      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- (grep -qxF "我的偏好是：回答尽量简短。" "${projectFile}" 2>/dev/null) || printf '%s\\n' "我的偏好是：回答尽量简短。" >> "${projectFile}"`,
          "如果已存在同样偏好，不要重复写入。",
          "完成后仅输出 REAL_DEDUPE_1_OK",
        ].join("\n"),
      });
      await runCodexTurn({
        orchestrator,
        fixture,
        sessionId,
        input: [
          "严格执行，不要解释：",
          `- mkdir -p "$(dirname "${projectFile}")"`,
          `- (grep -qxF "我的偏好是：回答尽量简短。" "${projectFile}" 2>/dev/null) || printf '%s\\n' "我的偏好是：回答尽量简短。" >> "${projectFile}"`,
          "仍然保持去重。",
          "完成后仅输出 REAL_DEDUPE_2_OK",
        ].join("\n"),
      });

      const lines = fileContent(projectFile)
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line.includes("回答尽量简短"));
      expect(lines.length).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  runner(
    "global mode: supports multiple real prompt styles",
    async () => {
      const fixture = makeMemoryFixture("real-prompt-variants");
      const globalFile = path.join(fixture.globalRoot, "preferences.md");
      const orchestrator = createRealCodexOrchestrator({
        memoryMode: "global",
        projectRoot: fixture.projectRoot,
        globalRoot: fixture.globalRoot,
        workspaceRoot: fixture.baseDir,
      });
      await ensureWritableSandbox({ orchestrator, sessionId: "real-style-1", fixture });

      const styles = [
        "我的偏好是：多用短句。",
        "偏好：输出请分点。",
        "请记住：我喜欢先结论后步骤。",
      ];

      for (let i = 0; i < styles.length; i += 1) {
        await runCodexTurn({
          orchestrator,
          fixture,
          sessionId: `real-style-${i + 1}`,
          input: [
            "严格执行，不要解释：",
            `- mkdir -p "$(dirname "${globalFile}")"`,
            `- (grep -qxF "${styles[i]}" "${globalFile}" 2>/dev/null) || printf '%s\\n' "${styles[i]}" >> "${globalFile}"`,
            `完成后仅输出 REAL_STYLE_${i + 1}_OK`,
          ].join("\n"),
        });
      }

      const recall = await runCodexTurn({
        orchestrator,
        fixture,
        sessionId: "real-style-recall",
        input: `读取 ${globalFile} 并列出已记录偏好，前缀 REAL_STYLE_RECALL。`,
      });
      expect(recall.finalText).toContain("REAL_STYLE_RECALL");
      expect(recall.finalText).toContain("多用短句");
      expect(recall.finalText).toContain("输出请分点");
      expect(recall.finalText).toContain("先结论后步骤");
    },
    TEST_TIMEOUT_MS,
  );
});
