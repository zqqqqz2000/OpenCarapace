import type { ToolRuntime } from "../core/tools";
import type { OpenClawCatalogSkill } from "../integrations/openclaw-skills";
import { createSkillLookupTool } from "../tools/skill-tool";

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
