import path from "node:path";
import { CloudCodeAgentAdapter, createCloudCodeCliBackend } from "./adapters/cloudcode.js";
import { ClaudeCodeAgentAdapter, createClaudeCodeCliBackend } from "./adapters/claudecode.js";
import { CodexAgentAdapter, createCodexCliBackend } from "./adapters/codex.js";
import { createChannelRegistryFromConfig, resolveChannelAgentRoutingFromConfig } from "./channels/factory.js";
import { ChannelGateway } from "./channels/gateway.js";
import {
  loadOpenCarapaceConfig,
  resolveOpenCarapaceConfigPath,
  resolveStringListFromFile,
  type OpenCarapaceConfig,
} from "./config/index.js";
import { AgentRegistry } from "./core/agent.js";
import { HookBus } from "./core/hooks.js";
import { ChatOrchestrator } from "./core/orchestrator.js";
import { FileSessionStore } from "./core/session.js";
import { SkillRuntime } from "./core/skills.js";
import { ToolRuntime } from "./core/tools.js";
import { ReadabilityPolicy } from "./core/ux-policy.js";
import { registerDefaultSkills } from "./presets/skill-packs.js";
import { registerDefaultTools } from "./presets/tool-packs.js";

export * from "./core/types.js";
export * from "./core/agent.js";
export * from "./core/hooks.js";
export * from "./core/naming.js";
export * from "./core/session.js";
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
export * from "./channels/bridge.js";
export * from "./channels/factory.js";
export * from "./config/index.js";
export * from "./integrations/openclaw-skills.js";
export * from "./adapters/backend.js";
export * from "./adapters/codex.js";
export * from "./adapters/cloudcode.js";
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
  const raw = params.rawPath?.trim();
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
  const workspaceRootRaw = config.runtime?.workspace_root?.trim();
  const workspaceRoot = workspaceRootRaw
    ? path.isAbsolute(workspaceRootRaw)
      ? workspaceRootRaw
      : path.resolve(path.dirname(configPath), workspaceRootRaw)
    : process.cwd();
  const readability = new ReadabilityPolicy({
    maxChars: 800,
    maxLines: 12,
  });

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
  }
  if (isEnabled(config.agents?.cloudcode?.enabled, false)) {
    const cloudcodeArgsParams = {} as {
      values?: string[];
      file?: string;
      configFilePath?: string;
    };
    if (config.agents?.cloudcode?.cli_args) {
      cloudcodeArgsParams.values = config.agents.cloudcode.cli_args;
    }
    if (config.agents?.cloudcode?.cli_args_file) {
      cloudcodeArgsParams.file = config.agents.cloudcode.cli_args_file;
    }
    cloudcodeArgsParams.configFilePath = configPath;
    const cloudcodeArgs = resolveStringListFromFile(cloudcodeArgsParams) ?? [];

    const cloudcodeParams = {
      args: cloudcodeArgs,
    } as {
      command?: string;
      args: string[];
    };
    const cloudcodeCommand = config.agents?.cloudcode?.cli_command?.trim();
    if (cloudcodeCommand) {
      cloudcodeParams.command = cloudcodeCommand;
    }

    const cloudcodeBackend = createCloudCodeCliBackend(cloudcodeParams);
    if (!cloudcodeBackend) {
      throw new Error(
        "agents.cloudcode.enabled=true but cli_command is missing in config.toml.",
      );
    }
    registry.register(new CloudCodeAgentAdapter(cloudcodeBackend));
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

  return new ChatOrchestrator({
    registry,
    hooks,
    skillRuntime: skills,
    toolRuntime: tools,
    sessionStore: sessions,
    readabilityPolicy: readability,
    defaultAgentId,
  });
}

export function createDefaultChannelGateway(options?: RuntimeBootstrapOptions & { orchestrator?: ChatOrchestrator }): ChannelGateway {
  const { config, configPath } = resolveRuntimeConfig(options);
  return new ChannelGateway({
    orchestrator: options?.orchestrator ?? createDefaultOrchestrator({ config, configPath }),
    registry: createChannelRegistryFromConfig({
      config,
      configFilePath: configPath,
    }),
    routing: resolveChannelAgentRoutingFromConfig(config),
  });
}
