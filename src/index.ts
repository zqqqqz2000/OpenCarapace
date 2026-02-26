import path from "node:path";
import { ClaudeCodeAgentAdapter, createClaudeCodeCliBackend } from "./adapters/claudecode.js";
import { CodexAgentAdapter, createCodexCliBackend, createCodexSessionTitleGenerator } from "./adapters/codex.js";
import { createChannelRegistryFromConfig, resolveChannelAgentRoutingFromConfig } from "./channels/factory.js";
import { ChannelGateway } from "./channels/gateway.js";
import {
  expandHomePath,
  loadOpenCarapaceConfig,
  resolveOpenCarapaceConfigPath,
  resolveStringListFromFile,
  type OpenCarapaceConfig,
} from "./config/index.js";
import { AgentRegistry } from "./core/agent.js";
import { HookBus } from "./core/hooks.js";
import { ChatOrchestrator } from "./core/orchestrator.js";
import type { SessionTitleGenerator } from "./core/session-title.js";
import { FileSessionStore } from "./core/session.js";
import { SkillRuntime } from "./core/skills.js";
import { ToolRuntime } from "./core/tools.js";
import { ReadabilityPolicy } from "./core/ux-policy.js";
import { registerDefaultSkills } from "./presets/skill-packs.js";
import { registerDefaultTools } from "./presets/tool-packs.js";

export * from "./core/types.js";
export * from "./core/agent.js";
export * from "./core/abort.js";
export * from "./core/hooks.js";
export * from "./core/naming.js";
export * from "./core/session.js";
export * from "./core/session-title.js";
export * from "./core/skills.js";
export * from "./core/memory-skill.js";
export * from "./core/commands.js";
export * from "./core/orchestrator.js";
export * from "./core/tools.js";
export * from "./channels/types.js";
export * from "./channels/registry.js";
export * from "./channels/session-key.js";
export * from "./channels/gateway.js";
export * from "./channels/telegram.js";
export * from "./channels/telegram-project-picker.js";
export * from "./channels/telegram-preferences-picker.js";
export * from "./channels/bridge.js";
export * from "./channels/turn-decision.js";
export * from "./channels/factory.js";
export * from "./config/index.js";
export * from "./integrations/openclaw-skills.js";
export * from "./adapters/backend.js";
export * from "./adapters/codex.js";
export * from "./adapters/claudecode.js";
export * from "./presets/skill-packs.js";
export * from "./presets/tool-packs.js";
export * from "./tools/grep-tool.js";
export * from "./tools/skill-tool.js";

export type RuntimeBootstrapOptions = {
  config?: OpenCarapaceConfig;
  configPath?: string;
};

function resolveRuntimeConfig(options?: RuntimeBootstrapOptions): {
  config: OpenCarapaceConfig;
  configPath: string;
} {
  const configPath = resolveOpenCarapaceConfigPath(options?.configPath);
  const config = options?.config ?? loadOpenCarapaceConfig({ path: configPath });
  return { config, configPath };
}

function isEnabled(value: boolean | undefined, fallback = true): boolean {
  return value === undefined ? fallback : value;
}

function resolvePathFromConfig(params: {
  rawPath: string | undefined;
  configPath: string;
  fallbackFileName: string;
}): string {
  const baseDir = path.dirname(params.configPath);
  const raw = params.rawPath ? expandHomePath(params.rawPath) : "";
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
  }
  return path.resolve(baseDir, params.fallbackFileName);
}

export function createDefaultOrchestrator(options?: RuntimeBootstrapOptions): ChatOrchestrator {
  const { config, configPath } = resolveRuntimeConfig(options);
  const registry = new AgentRegistry();
  const hooks = new HookBus();
  const skills = new SkillRuntime();
  const tools = new ToolRuntime();
  const sessions = new FileSessionStore({
    filePath: resolvePathFromConfig({
      rawPath: config.runtime?.session_store_file,
      configPath,
      fallbackFileName: "sessions.json",
    }),
  });
  const workspaceRootRaw = config.runtime?.workspace_root ? expandHomePath(config.runtime.workspace_root) : "";
  const workspaceRoot = workspaceRootRaw
    ? path.isAbsolute(workspaceRootRaw)
      ? workspaceRootRaw
      : path.resolve(path.dirname(configPath), workspaceRootRaw)
    : process.cwd();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });
  let sessionTitleGenerator: SessionTitleGenerator | undefined;

  if (isEnabled(config.agents?.codex?.enabled, true)) {
    const codexArgsParams = {} as {
      values?: string[];
      file?: string;
      configFilePath?: string;
    };
    if (config.agents?.codex?.cli_args) {
      codexArgsParams.values = config.agents.codex.cli_args;
    }
    if (config.agents?.codex?.cli_args_file) {
      codexArgsParams.file = config.agents.codex.cli_args_file;
    }
    codexArgsParams.configFilePath = configPath;
    const codexCliArgs = resolveStringListFromFile(codexArgsParams) ?? [];

    const codexCliParams = {
      args: codexCliArgs,
    } as {
      command?: string;
      args: string[];
    };
    const command = config.agents?.codex?.cli_command?.trim();
    if (command) {
      codexCliParams.command = command;
    }

    const codexCli = createCodexCliBackend(codexCliParams);
    registry.register(new CodexAgentAdapter(codexCli ? { backend: codexCli } : undefined));
    const titleGeneratorParams = {
      args: codexCliArgs,
    } as {
      command?: string;
      args: string[];
    };
    if (command) {
      titleGeneratorParams.command = command;
    }
    sessionTitleGenerator = createCodexSessionTitleGenerator(titleGeneratorParams) ?? undefined;
  }
  if (isEnabled(config.agents?.claude_code?.enabled, false)) {
    const claudeArgsParams = {} as {
      values?: string[];
      file?: string;
      configFilePath?: string;
    };
    if (config.agents?.claude_code?.cli_args) {
      claudeArgsParams.values = config.agents.claude_code.cli_args;
    }
    if (config.agents?.claude_code?.cli_args_file) {
      claudeArgsParams.file = config.agents.claude_code.cli_args_file;
    }
    claudeArgsParams.configFilePath = configPath;
    const claudeArgs = resolveStringListFromFile(claudeArgsParams) ?? [];

    const claudeParams = {
      args: claudeArgs,
    } as {
      command?: string;
      args: string[];
    };
    const claudeCommand = config.agents?.claude_code?.cli_command?.trim();
    if (claudeCommand) {
      claudeParams.command = claudeCommand;
    }

    const claudeBackend = createClaudeCodeCliBackend(claudeParams);
    if (!claudeBackend) {
      throw new Error(
        "agents.claude_code.enabled=true but cli_command is missing in config.toml.",
      );
    }
    registry.register(new ClaudeCodeAgentAdapter(claudeBackend));
  }

  if (registry.list().length === 0) {
    throw new Error("No agents enabled. Please enable at least one agent in config.toml.");
  }

  const skillPreset = registerDefaultSkills(skills, { config });
  registerDefaultTools(tools, {
    workspaceRoot,
    openClawSkill: skillPreset.openClawSkill,
  });

  const defaultAgentId =
    config.runtime?.default_agent_id?.trim() || config.channels?.routing?.default_agent_id?.trim() || "codex";

  const orchestratorDeps = {
    registry,
    hooks,
    skillRuntime: skills,
    toolRuntime: tools,
    sessionStore: sessions,
    readabilityPolicy: readability,
    defaultAgentId,
  } as {
    registry: AgentRegistry;
    hooks: HookBus;
    skillRuntime: SkillRuntime;
    toolRuntime: ToolRuntime;
    sessionTitleGenerator?: SessionTitleGenerator;
    sessionStore: FileSessionStore;
    readabilityPolicy: ReadabilityPolicy;
    defaultAgentId: string;
  };
  if (sessionTitleGenerator) {
    orchestratorDeps.sessionTitleGenerator = sessionTitleGenerator;
  }
  return new ChatOrchestrator(orchestratorDeps);
}

export function createDefaultChannelGateway(options?: RuntimeBootstrapOptions & { orchestrator?: ChatOrchestrator }): ChannelGateway {
  const { config, configPath } = resolveRuntimeConfig(options);
  const projectRootRaw = config.runtime?.project_root_dir ? expandHomePath(config.runtime.project_root_dir) : "";
  const projectRootDir = projectRootRaw
    ? path.isAbsolute(projectRootRaw)
      ? projectRootRaw
      : path.resolve(path.dirname(configPath), projectRootRaw)
    : undefined;
  const gatewayDeps = {
    orchestrator: options?.orchestrator ?? createDefaultOrchestrator({ config, configPath }),
    registry: createChannelRegistryFromConfig({
      config,
      configFilePath: configPath,
    }),
    routing: resolveChannelAgentRoutingFromConfig(config),
  } as {
    orchestrator: ChatOrchestrator;
    registry: ReturnType<typeof createChannelRegistryFromConfig>;
    routing: ReturnType<typeof resolveChannelAgentRoutingFromConfig>;
    projectRootDir?: string;
  };
  if (projectRootDir) {
    gatewayDeps.projectRootDir = projectRootDir;
  }
  return new ChannelGateway(gatewayDeps);
}
