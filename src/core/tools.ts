import { assertInjectableId } from "./naming.js";
import type { AgentId } from "./types.js";

const TOOL_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type ToolExecutionContext = {
  sessionId: string;
  currentAgentId: AgentId;
  input: string;
  args: string[];
  cwd: string;
};

export type ToolExecutionResult = {
  text: string;
};

export interface CommandTool {
  readonly id: string;
  readonly name: string;
  readonly aliases?: string[];
  readonly description: string;
  execute(context: ToolExecutionContext): ToolExecutionResult | string;
}

export class ToolRuntime {
  private readonly tools: CommandTool[] = [];
  private readonly byId = new Set<string>();
  private readonly byName = new Map<string, CommandTool>();

  register(tool: CommandTool): void {
    assertInjectableId("tool", tool.id);
    if (this.byId.has(tool.id)) {
      throw new Error(`duplicate tool id: ${tool.id}`);
    }
    this.assertToolName(tool.name, tool.id);
    this.registerAlias(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.assertToolName(alias, tool.id);
      this.registerAlias(alias, tool);
    }
    this.tools.push(tool);
    this.byId.add(tool.id);
  }

  list(): CommandTool[] {
    return [...this.tools];
  }

  resolve(name: string): CommandTool | undefined {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    return this.byName.get(normalized);
  }

  run(name: string, context: ToolExecutionContext): ToolExecutionResult | null {
    const tool = this.resolve(name);
    if (!tool) {
      return null;
    }
    const result = tool.execute(context);
    if (typeof result === "string") {
      return { text: result };
    }
    return result;
  }

  private assertToolName(name: string, toolId: string): void {
    const normalized = name.trim().toLowerCase();
    if (TOOL_NAME_RE.test(normalized)) {
      return;
    }
    throw new Error(
      `invalid tool name "${name}" for ${toolId}: expected ${TOOL_NAME_RE.toString()}`,
    );
  }

  private registerAlias(alias: string, tool: CommandTool): void {
    const normalized = alias.trim().toLowerCase();
    const existing = this.byName.get(normalized);
    if (existing) {
      throw new Error(`duplicate tool alias "${normalized}" for ${tool.id} and ${existing.id}`);
    }
    this.byName.set(normalized, tool);
  }
}
