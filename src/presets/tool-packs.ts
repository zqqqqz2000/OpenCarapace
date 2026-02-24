import type { ToolRuntime } from "../core/tools.js";
import type { OpenClawCatalogSkill } from "../integrations/openclaw-skills.js";
import { createGrepWorkspaceTool } from "../tools/grep-tool.js";
import { createSkillLookupTool } from "../tools/skill-tool.js";

export function registerDefaultTools(
  runtime: ToolRuntime,
  options?: {
    workspaceRoot?: string;
    openClawSkill?: OpenClawCatalogSkill | null;
  },
): void {
  const grepParams = {} as {
    defaultRootDir?: string;
  };
  if (options?.workspaceRoot) {
    grepParams.defaultRootDir = options.workspaceRoot;
  }
  runtime.register(
    createGrepWorkspaceTool(grepParams),
  );

  runtime.register(
    createSkillLookupTool({
      docsProvider: () => options?.openClawSkill?.listDocs() ?? [],
      maxResults: 10,
      maxSnippetChars: 1200,
    }),
  );
}
