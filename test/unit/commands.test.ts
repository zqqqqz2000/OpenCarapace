import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ConversationCommandService, parseSlashCommand } from "../../src/core/commands.js";
import { AgentRegistry } from "../../src/core/agent.js";
import { SessionManager, InMemorySessionStore } from "../../src/core/session.js";
import { SkillRuntime, InstructionSkill } from "../../src/core/skills.js";
import { ToolRuntime } from "../../src/core/tools.js";
import { CodexAgentAdapter } from "../../src/adapters/codex.js";
import { CloudCodeAgentAdapter } from "../../src/adapters/cloudcode.js";
import { OpenClawCatalogSkill } from "../../src/integrations/openclaw-skills.js";
import { createGrepWorkspaceTool } from "../../src/tools/grep-tool.js";
import { createSkillLookupTool } from "../../src/tools/skill-tool.js";

function createService(): ConversationCommandService {
  const registry = new AgentRegistry();
  registry.register(new CodexAgentAdapter());
  registry.register(new CloudCodeAgentAdapter());

  const skills = new SkillRuntime();
  skills.register(
    new InstructionSkill({
      id: "codex.readable.final",
      description: "readable final",
      instruction: "keep final concise",
      appliesTo: ["codex"],
    }),
  );
  skills.register(
    new OpenClawCatalogSkill([
      {
        id: "deploy-checklist",
        name: "Deploy Checklist",
        filePath: "/tmp/deploy/SKILL.md",
        summary: "Safe deployment with rollback and validation",
        content: "Ensure rollback steps are prepared.",
      },
    ]),
  );

  const tools = new ToolRuntime();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-cmd-test-"));
  const sourceFile = path.join(tmpDir, "sample.txt");
  writeFileSync(sourceFile, "deploy-safe-token\nroll back plan\n", "utf-8");
  tools.register(
    createGrepWorkspaceTool({
      defaultRootDir: tmpDir,
    }),
  );
  tools.register(
    createSkillLookupTool({
      docsProvider: () => {
        const openclaw = skills
          .listAll()
          .find((skill): skill is OpenClawCatalogSkill => skill instanceof OpenClawCatalogSkill);
        return openclaw?.listDocs() ?? [];
      },
    }),
  );

  return new ConversationCommandService({
    registry,
    sessions: new SessionManager(new InMemorySessionStore()),
    skills,
    tools,
  });
}

describe("parseSlashCommand", () => {
  test("parses command name and args", () => {
    expect(parseSlashCommand("/memory show 3")).toEqual({
      name: "memory",
      args: ["show", "3"],
      raw: "/memory show 3",
    });
  });

  test("handles quoted args", () => {
    const parsed = parseSlashCommand("/agent \"cloudcode\"");
    expect(parsed?.name).toBe("agent");
    expect(parsed?.args).toEqual(["cloudcode"]);
  });

  test("returns null for non command input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });
});

describe("ConversationCommandService", () => {
  test("returns help from /command list", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/command list",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("/status");
  });

  test("switches agent on /agent command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/agent cloudcode",
    });

    expect(result.handled).toBeTrue();
    expect(result.agentId).toBe("cloudcode");
    expect(result.finalText).toContain("Agent switched");
  });

  test("lists openclaw catalog by /skills catalog", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/skills catalog 5",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("OpenClaw skills");
    expect(result.finalText).toContain("Deploy Checklist");
  });

  test("runs grep tool by /grep command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/grep deploy-safe-token --path sample.txt --limit 3",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Grep matches");
    expect(result.finalText).toContain("deploy-safe-token");
  });

  test("runs skill lookup by /skill command", () => {
    const service = createService();
    const result = service.execute({
      sessionId: "s1",
      currentAgentId: "codex",
      input: "/skill deploy rollback",
    });

    expect(result.handled).toBeTrue();
    expect(result.finalText).toContain("Skill matches");
    expect(result.finalText).toContain("Deploy Checklist");
  });
});
