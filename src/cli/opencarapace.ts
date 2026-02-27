import os from "node:os";
import path from "node:path";
import { cancel, confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts";
import type { OpenCarapaceConfig } from "../config/types.js";
import {
  ensureOpenCarapaceConfig,
  loadOpenCarapaceConfig,
  parseConfigValue,
  renderOpenCarapaceConfigToml,
  resolveOpenCarapaceConfigPath,
  saveOpenCarapaceConfig,
  setConfigValueByPath,
} from "../config/index.js";
import { runChatCli } from "./chat.js";
import { runGateway } from "./gateway.js";
import { runServer } from "./server.js";

const SUPPORTED_AGENT_IDS = ["codex", "claude-code"] as const;
const ROUTABLE_CHANNEL_IDS = ["telegram", "slack", "discord", "wechat"] as const;

type SupportedAgentId = (typeof SUPPORTED_AGENT_IDS)[number];

function usage(): string {
  return [
    "OpenCarapace CLI",
    "",
    "Usage:",
    "  opencarapace [--config <path>] chat <sessionId> <message> [--agent <agentId>]",
    "  opencarapace [--config <path>] serve",
    "  opencarapace [--config <path>] gateway",
    "  opencarapace [--config <path>] config path",
    "  opencarapace [--config <path>] config init",
    "  opencarapace [--config <path>] config show",
    "  opencarapace [--config <path>] config set <dot.path> <value>",
    "  opencarapace [--config <path>] config tui",
    "  opencarapace [--config <path>] config wizard",
    "",
    "Examples:",
    "  opencarapace config init",
    "  opencarapace config set channels.telegram.enabled true",
    "  opencarapace config set channels.telegram.token_file ~/.secrets/telegram-token.txt",
    "  opencarapace gateway",
  ].join("\n");
}

function parseGlobalArgs(argv: string[]): { args: string[]; configPath?: string } {
  const args = [...argv];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--config") {
      continue;
    }
    const value = args[i + 1]?.trim();
    if (!value) {
      throw new Error("--config requires a path value");
    }
    configPath = value;
    args.splice(i, 2);
    break;
  }
  const parsed = {
    args,
  } as {
    args: string[];
    configPath?: string;
  };
  if (configPath) {
    parsed.configPath = configPath;
  }
  return parsed;
}

class ConfigWizardCancelledError extends Error {}

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new ConfigWizardCancelledError();
  }
  return value;
}

function normalizeInput(raw: string, fallback?: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed === "-") {
    return "";
  }
  return trimmed;
}

function parseCsv(raw: string, fallback: string[] | undefined): string[] | undefined {
  const normalized = raw.trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "-") {
    return [];
  }
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberInput(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^\d+$/.test(trimmed)) {
    return NaN;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return NaN;
  }
  return parsed;
}

async function promptTextInput(
  message: string,
  initialValue = "",
  placeholder?: string,
): Promise<string> {
  const options = {
    message,
    initialValue,
  } as {
    message: string;
    initialValue: string;
    placeholder?: string;
  };
  if (placeholder !== undefined) {
    options.placeholder = placeholder;
  }
  const value = guardCancel(
    await text(options),
  );
  return String(value ?? "");
}

async function promptNormalizedInput(
  message: string,
  fallback?: string,
  placeholder?: string,
): Promise<string | undefined> {
  const raw = await promptTextInput(message, fallback ?? "", placeholder);
  return normalizeInput(raw, fallback);
}

async function promptNumberInput(
  message: string,
  fallback: number,
  placeholder?: string,
): Promise<number> {
  while (true) {
    const raw = await promptTextInput(message, String(fallback), placeholder);
    const parsed = parseNumberInput(raw, fallback);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    note("请输入正整数（>= 1），留空可保留当前值。", "Input validation");
  }
}

function normalizeAgentId(raw: string | undefined): SupportedAgentId | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim();
  if (normalized === "codex" || normalized === "claude-code") {
    return normalized;
  }
  return undefined;
}

function renderCurrentSummary(config: OpenCarapaceConfig): string {
  const defaultAgent = config.runtime?.default_agent_id ?? "codex";
  const sessionStoreFile = config.runtime?.session_store_file ?? "sessions.json";
  const projectRootDir = config.runtime?.project_root_dir ?? "";
  const codex = config.agents?.codex;
  const claude = config.agents?.claude_code;
  const telegram = config.channels?.telegram;
  const slack = config.channels?.slack;
  const discord = config.channels?.discord;
  const wechat = config.channels?.wechat;
  const skills = config.skills;

  return [
    "Current config summary",
    `- default agent: ${defaultAgent}`,
    `- session store: ${sessionStoreFile}`,
    `- project root: ${projectRootDir || "(required in config tui, subdirectories are projects)"}`,
    `- agents: codex=${codex?.enabled ?? true}, claude-code=${claude?.enabled ?? false}`,
    `- channels: telegram=${telegram?.enabled ?? false}, slack=${slack?.enabled ?? false}, discord=${discord?.enabled ?? false}, wechat=${wechat?.enabled ?? false}`,
    `- openclaw catalog: ${skills?.enable_openclaw_catalog ?? true}`,
  ].join("\n");
}

async function configureAgentBlock(params: {
  config: OpenCarapaceConfig;
  key: "codex" | "claude_code";
  displayName: string;
  defaultEnabled: boolean;
  defaultCommand?: string;
  defaultArgs?: string[];
}): Promise<void> {
  const { config } = params;
  const current = config.agents?.[params.key] ?? {};
  const enabledCurrent =
    typeof current.enabled === "boolean" ? current.enabled : params.defaultEnabled;
  const enabled = guardCancel(
    await confirm({
      message: `Enable ${params.displayName}?`,
      initialValue: enabledCurrent,
    }),
  );
  if (!enabled) {
    config.agents = {
      ...(config.agents ?? {}),
      [params.key]: {
        ...current,
        enabled: false,
      },
    };
    note(`${params.displayName} disabled. Skipped command/args prompts.`, params.displayName);
    return;
  }

  const commandCurrent = current.cli_command ?? params.defaultCommand ?? "";
  const argsCurrent = current.cli_args ?? params.defaultArgs ?? [];
  const argsFileCurrent = current.cli_args_file ?? "";
  const commandPlaceholder = params.defaultCommand ?? params.displayName.toLowerCase().replace(/\s+/g, "-");
  const command = await promptNormalizedInput(
    `${params.displayName} CLI command ("-" to clear)`,
    commandCurrent,
    commandPlaceholder,
  );
  const argsText = await promptNormalizedInput(
    `${params.displayName} CLI args, space-separated ("-" to clear)`,
    argsCurrent.join(" "),
    "exec {{prompt}}",
  );
  const argsFile = await promptNormalizedInput(
    `${params.displayName} CLI args file (optional, takes effect when args are empty; "-" to clear)`,
    argsFileCurrent,
    "/path/to/args.txt",
  );

  config.agents = {
    ...(config.agents ?? {}),
    [params.key]: {
      ...current,
      enabled,
      cli_command: command || "",
      cli_args: argsText ? argsText.split(/\s+/g).filter(Boolean) : [],
      cli_args_file: argsFile || "",
    },
  };
}

async function configureRuntimeAndAgents(
  config: OpenCarapaceConfig,
): Promise<void> {
  const defaultAgentCurrent = config.runtime?.default_agent_id ?? "codex";
  const defaultAgent = guardCancel(
    await select({
      message: "Default agent",
      initialValue: normalizeAgentId(defaultAgentCurrent) ?? "codex",
      options: [
        { value: "codex", label: "codex" },
        { value: "claude-code", label: "claude-code" },
      ],
    }),
  );

  const portCurrent = config.runtime?.port ?? 3000;
  const gatewayPortCurrent = config.runtime?.gateway_port ?? 3010;
  const port = await promptNumberInput("HTTP server port", portCurrent, "3000");
  const gatewayPort = await promptNumberInput("Gateway port", gatewayPortCurrent, "3010");

  const sessionStoreFileCurrent = config.runtime?.session_store_file ?? "sessions.json";
  const sessionStoreFile = await promptNormalizedInput(
    'Session store file ("-" to clear, default sessions.json)',
    sessionStoreFileCurrent,
    "sessions.json",
  );
  const defaultProjectRoot = path.resolve(os.homedir(), "Documents");
  const projectRootCurrent = config.runtime?.project_root_dir?.trim() || defaultProjectRoot;
  let projectRoot = (await promptNormalizedInput(
    "Project root directory (required; its subdirectories are treated as projects)",
    projectRootCurrent,
    defaultProjectRoot,
  )) ?? "";
  while (!projectRoot.trim()) {
    const candidate = await promptNormalizedInput(
      "Project root directory (required; its subdirectories are treated as projects)",
      projectRootCurrent,
      defaultProjectRoot,
    );
    projectRoot = candidate ?? "";
    if (!projectRoot.trim()) {
      note("Project root directory is required, and its subdirectories are project options.", "Runtime & Agents");
    }
  }

  config.runtime = {
    ...(config.runtime ?? {}),
    default_agent_id: defaultAgent || "codex",
    port,
    gateway_port: gatewayPort,
    session_store_file: sessionStoreFile || "",
    project_root_dir: projectRoot.trim(),
  };

  await configureAgentBlock({
    config,
    key: "codex",
    displayName: "Codex",
    defaultEnabled: true,
    defaultCommand: "codex",
    defaultArgs: ["exec", "{{prompt}}"],
  });
  await configureAgentBlock({
    config,
    key: "claude_code",
    displayName: "Claude Code",
    defaultEnabled: false,
    defaultCommand: "claude",
    defaultArgs: ["-p", "{{prompt}}"],
  });

  note("Updated runtime and agent settings in memory.", "Runtime & Agents");
}

async function configureTelegramChannel(
  config: OpenCarapaceConfig,
): Promise<void> {
  const current = config.channels?.telegram ?? {};
  const enabledCurrent = current.enabled ?? false;
  const enabled = guardCancel(
    await confirm({
      message: "Enable Telegram?",
      initialValue: enabledCurrent,
    }),
  );
  if (!enabled) {
    config.channels = {
      ...(config.channels ?? {}),
      telegram: {
        ...current,
        enabled: false,
      },
    };
    note("Telegram disabled. Skipped token/chat prompts.", "Telegram");
    return;
  }
  const token = await promptNormalizedInput(
    'Telegram token (supports @file:/path, "-" to clear)',
    current.token,
    "@file:/path/to/token.txt",
  );
  const tokenFile = await promptNormalizedInput(
    'Telegram token_file (optional, "-" to clear)',
    current.token_file,
    "/path/to/token.txt",
  );
  const allowed = parseCsv(
    await promptTextInput(
      'Allowed chat ids CSV ("-" to clear)',
      (current.allowed_chat_ids ?? []).join(","),
      "12345,67890",
    ),
    current.allowed_chat_ids,
  );
  const pollTimeout = await promptNumberInput(
    "Poll timeout seconds",
    current.poll_timeout_seconds ?? 25,
    "25",
  );
  const retryDelay = await promptNumberInput(
    "Retry delay ms",
    current.retry_delay_ms ?? 1200,
    "1200",
  );

  config.channels = {
    ...(config.channels ?? {}),
    telegram: {
      ...current,
      enabled,
      token: token || "",
      token_file: tokenFile || "",
      allowed_chat_ids: allowed ?? [],
      poll_timeout_seconds: pollTimeout,
      retry_delay_ms: retryDelay,
    },
  };

  note("Updated Telegram bridge settings in memory.", "Telegram");
}

async function configureBridgeChannel(
  config: OpenCarapaceConfig,
  key: "slack" | "discord" | "wechat",
  displayName: string,
): Promise<void> {
  const current = config.channels?.[key] ?? {};
  const enabledCurrent = current.enabled ?? false;
  const enabled = guardCancel(
    await confirm({
      message: `Enable ${displayName} bridge?`,
      initialValue: enabledCurrent,
    }),
  );
  if (!enabled) {
    config.channels = {
      ...(config.channels ?? {}),
      [key]: {
        ...current,
        enabled: false,
      },
    };
    note(`${displayName} disabled. Skipped secret/webhook prompts.`, displayName);
    return;
  }
  const inboundSecret = await promptNormalizedInput(
    `${displayName} inbound secret (supports @file:/path, "-" to clear)`,
    current.inbound_secret,
    "@file:/path/to/secret.txt",
  );
  const inboundSecretFile = await promptNormalizedInput(
    `${displayName} inbound_secret_file (optional, "-" to clear)`,
    current.inbound_secret_file,
    "/path/to/secret.txt",
  );
  const outboundWebhookUrl = await promptNormalizedInput(
    `${displayName} outbound webhook URL (supports @file:/path, "-" to clear)`,
    current.outbound_webhook_url,
    "https://hooks.example.com/...",
  );
  const outboundWebhookUrlFile = await promptNormalizedInput(
    `${displayName} outbound_webhook_url_file (optional, "-" to clear)`,
    current.outbound_webhook_url_file,
    "/path/to/webhook-url.txt",
  );

  config.channels = {
    ...(config.channels ?? {}),
    [key]: {
      ...current,
      enabled,
      inbound_secret: inboundSecret || "",
      inbound_secret_file: inboundSecretFile || "",
      outbound_webhook_url: outboundWebhookUrl || "",
      outbound_webhook_url_file: outboundWebhookUrlFile || "",
    },
  };

  note(`Updated ${displayName} bridge settings in memory.`, displayName);
}

async function configureChannelRouting(config: OpenCarapaceConfig): Promise<void> {
  const defaultRouteCurrentRaw =
    config.channels?.routing?.default_agent_id ?? config.runtime?.default_agent_id ?? "codex";
  const defaultRouteCurrent = normalizeAgentId(defaultRouteCurrentRaw) ?? "codex";
  const defaultRoute = guardCancel(
    await select({
      message: "Default routed agent",
      initialValue: defaultRouteCurrent,
      options: [
        { value: "codex", label: "codex" },
        { value: "claude-code", label: "claude-code" },
      ],
    }),
  ) as SupportedAgentId;
  const entriesCurrent = config.channels?.routing?.entries ?? {};
  const entries = {} as Record<string, string>;
  for (const channelId of ROUTABLE_CHANNEL_IDS) {
    const currentAgent = normalizeAgentId(entriesCurrent[channelId]);
    const selected = guardCancel(
      await select({
        message: `Route for ${channelId}`,
        initialValue: currentAgent && currentAgent !== defaultRoute ? currentAgent : "default",
        options: [
          { value: "default", label: `inherit default (${defaultRoute})` },
          { value: "codex", label: "codex" },
          { value: "claude-code", label: "claude-code" },
        ],
      }),
    );
    if (selected === "default") {
      continue;
    }
    const normalized = normalizeAgentId(String(selected));
    if (!normalized) {
      continue;
    }
    entries[channelId] = normalized;
  }
  for (const [channelId, agentRaw] of Object.entries(entriesCurrent)) {
    if ((ROUTABLE_CHANNEL_IDS as readonly string[]).includes(channelId)) {
      continue;
    }
    const normalized = normalizeAgentId(agentRaw);
    if (!normalized) {
      note(`Dropped invalid route: ${channelId}:${agentRaw}`, "Routing");
      continue;
    }
    entries[channelId] = normalized;
  }

  config.channels = {
    ...(config.channels ?? {}),
    routing: {
      ...(config.channels?.routing ?? {}),
      default_agent_id: defaultRoute,
      entries,
    },
  };

  note("Updated channel routing in memory.", "Routing");
}

async function configureChannelsSection(
  config: OpenCarapaceConfig,
): Promise<void> {
  while (true) {
    const answer = guardCancel(
      await select({
        message: "Configure channels",
        options: [
          { value: "telegram", label: "Telegram" },
          { value: "slack", label: "Slack bridge" },
          { value: "discord", label: "Discord bridge" },
          { value: "wechat", label: "WeChat bridge" },
          { value: "routing", label: "Routing map" },
          { value: "back", label: "Back" },
        ],
      }),
    );

    if (answer === "back") {
      return;
    }
    if (answer === "telegram") {
      await configureTelegramChannel(config);
      continue;
    }
    if (answer === "slack") {
      await configureBridgeChannel(config, "slack", "Slack");
      continue;
    }
    if (answer === "discord") {
      await configureBridgeChannel(config, "discord", "Discord");
      continue;
    }
    if (answer === "wechat") {
      await configureBridgeChannel(config, "wechat", "WeChat");
      continue;
    }
    if (answer === "routing") {
      await configureChannelRouting(config);
      continue;
    }
  }
}

async function configureSkillsSection(
  config: OpenCarapaceConfig,
): Promise<void> {
  const current = config.skills ?? {};
  const enabledCurrent = current.enable_openclaw_catalog ?? true;
  const enabled = guardCancel(
    await confirm({
      message: "Enable OpenClaw catalog?",
      initialValue: enabledCurrent,
    }),
  );
  const root = await promptNormalizedInput(
    'OpenClaw root ("-" to clear)',
    current.openclaw_root,
    "/Users/zzzz/Documents/openclaw",
  );
  const dirs = parseCsv(
    await promptTextInput(
      'OpenClaw skill dirs CSV ("-" to clear)',
      (current.openclaw_skill_dirs ?? []).join(","),
      "skills,extensions/*/skills",
    ),
    current.openclaw_skill_dirs,
  );
  const maxSelected = await promptNumberInput(
    "OpenClaw max selected skills",
    current.openclaw_max_selected_skills ?? 2,
    "2",
  );
  const maxSnippet = await promptNumberInput(
    "OpenClaw max snippet chars",
    current.openclaw_max_snippet_chars ?? 900,
    "900",
  );

  config.skills = {
    ...current,
    enable_openclaw_catalog: enabled,
    openclaw_root: root || "",
    openclaw_skill_dirs: dirs ?? [],
    openclaw_max_selected_skills: maxSelected,
    openclaw_max_snippet_chars: maxSnippet,
  };

  note("Updated skills settings in memory.", "Skills");
}

async function runConfigTui(configPath?: string): Promise<void> {
  const resolved = resolveOpenCarapaceConfigPath(configPath);
  const base = ensureOpenCarapaceConfig({ path: resolved }).config;
  const config: OpenCarapaceConfig = structuredClone(base);

  try {
    intro("OpenCarapace Config Wizard");
    note(resolved, "Config file");
    while (true) {
      note(renderCurrentSummary(config), "Current summary");
      const choice = guardCancel(
        await select({
          message: "Configure section",
          options: [
            { value: "runtime", label: "Runtime & Agents" },
            { value: "channels", label: "Channels" },
            { value: "skills", label: "Skills" },
            { value: "show", label: "Show full config TOML" },
            { value: "save", label: "Save and exit" },
            { value: "exit", label: "Exit without saving" },
          ],
        }),
      );

      if (choice === "runtime") {
        await configureRuntimeAndAgents(config);
        continue;
      }
      if (choice === "channels") {
        await configureChannelsSection(config);
        continue;
      }
      if (choice === "skills") {
        await configureSkillsSection(config);
        continue;
      }
      if (choice === "show") {
        note(renderOpenCarapaceConfigToml(config), "config.toml preview");
        continue;
      }
      if (choice === "save") {
        saveOpenCarapaceConfig(config, { path: resolved });
        outro(`Saved config: ${resolved}`);
        return;
      }
      if (choice === "exit") {
        outro("Exit without saving.");
        return;
      }
    }
  } catch (error) {
    if (error instanceof ConfigWizardCancelledError) {
      cancel("Config wizard cancelled.");
      return;
    }
    throw error;
  } finally {
    // no-op
  }
}

async function runConfigCommand(args: string[], configPath?: string): Promise<void> {
  const resolved = resolveOpenCarapaceConfigPath(configPath);
  const sub = args[0]?.trim().toLowerCase();

  if (!sub || sub === "help") {
    console.log(
      [
        "config commands:",
        "  opencarapace config path",
        "  opencarapace config init",
        "  opencarapace config show",
        "  opencarapace config set <dot.path> <value>",
        "  opencarapace config tui",
        "  opencarapace config wizard",
      ].join("\n"),
    );
    return;
  }

  if (sub === "path") {
    console.log(resolved);
    return;
  }

  if (sub === "init") {
    const created = ensureOpenCarapaceConfig({ path: resolved }).created;
    console.log(`${created ? "Created" : "Already exists"}: ${resolved}`);
    return;
  }

  if (sub === "show") {
    const config = loadOpenCarapaceConfig({ path: resolved, strict: true });
    console.log(renderOpenCarapaceConfigToml(config));
    return;
  }

  if (sub === "set") {
    const keyPath = args[1]?.trim();
    const rawValue = args.slice(2).join(" ").trim();
    if (!keyPath || !rawValue) {
      throw new Error("usage: opencarapace config set <dot.path> <value>");
    }
    const config = loadOpenCarapaceConfig({ path: resolved });
    setConfigValueByPath(config, keyPath, parseConfigValue(rawValue));
    saveOpenCarapaceConfig(config, { path: resolved });
    console.log(`Updated ${keyPath} in ${resolved}`);
    return;
  }

  if (sub === "tui" || sub === "wizard") {
    await runConfigTui(resolved);
    return;
  }

  throw new Error(`unknown config subcommand: ${sub}`);
}

export async function runOpenCarapaceCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseGlobalArgs(argv);
  const args = parsed.args;
  const command = args[0]?.trim().toLowerCase();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "chat") {
    if (parsed.configPath) {
      await runChatCli(args.slice(1), { configPath: parsed.configPath });
    } else {
      await runChatCli(args.slice(1));
    }
    return;
  }

  if (command === "serve" || command === "server") {
    if (parsed.configPath) {
      await runServer({ configPath: parsed.configPath });
    } else {
      await runServer();
    }
    return;
  }

  if (command === "gateway") {
    if (parsed.configPath) {
      await runGateway({ configPath: parsed.configPath });
    } else {
      await runGateway();
    }
    return;
  }

  if (command === "config") {
    await runConfigCommand(args.slice(1), parsed.configPath);
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

if (import.meta.main) {
  runOpenCarapaceCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
