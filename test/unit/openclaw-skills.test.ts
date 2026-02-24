import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  OpenClawCatalogSkill,
  loadOpenClawSkillDocs,
} from "../../src/integrations/openclaw-skills.js";

function writeSkill(root: string, name: string, markdown: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown, "utf-8");
}

describe("OpenClaw skills integration", () => {
  test("loads SKILL.md docs from root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-"));

    writeSkill(
      root,
      "deploy-checklist",
      `---
title: Deploy Checklist
description: Safe production deployment checklist.
---
# Deploy Checklist
Verify rollout and rollback steps.`,
    );

    const docs = loadOpenClawSkillDocs({ roots: [root] });
    expect(docs.length).toBe(1);
    expect(docs[0]?.name).toContain("Deploy Checklist");
    expect(docs[0]?.summary).toContain("Safe production deployment");
  });

  test("injects relevant skill snippets based on prompt", () => {
    const skill = new OpenClawCatalogSkill(
      [
        {
          id: "deploy-checklist",
          name: "Deploy Checklist",
          filePath: "/skills/deploy/SKILL.md",
          summary: "Safe production deployment checklist.",
          content: "Always include rollout verification and rollback procedure.",
        },
        {
          id: "sql-optimization",
          name: "SQL Optimization",
          filePath: "/skills/sql/SKILL.md",
          summary: "Database query and index optimization.",
          content: "Inspect query plans before adding indexes.",
        },
      ],
      { maxSelectedSkills: 1, maxSnippetChars: 300 },
    );

    const patch = skill.beforeTurn({
      request: {
        agentId: "codex",
        sessionId: "s",
        prompt: "please give me a deploy rollback checklist",
        messages: [],
        systemDirectives: [],
        skills: [],
      },
    });

    const merged = patch?.systemDirectives?.join("\n") ?? "";
    expect(merged).toContain("Deploy Checklist");
    expect(merged).toContain("rollback");
  });
});
