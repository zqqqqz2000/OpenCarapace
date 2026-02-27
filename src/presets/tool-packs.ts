import type { ToolRuntime } from "../core/tools.js";
import type { OpenClawCatalogSkill } from "../integrations/openclaw-skills.js";
import { createSkillLookupTool } from "../tools/skill-tool.js";

export function registerDefaultTools(
  runtime: ToolRuntime,
  options?: {
    openClawSkill?: OpenClawCatalogSkill | null;
  },
): void {
  runtime.register(
    createSkillLookupTool({
      docsProvider: () => options?.openClawSkill?.listDocs() ?? [],
      maxResults: 10,
      maxSnippetChars: 1200,
    }),
  );
}
