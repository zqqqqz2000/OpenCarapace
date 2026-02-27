import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  defaultOpenCarapaceConfig,
  renderOpenCarapaceConfigToml,
  loadOpenCarapaceConfig,
  saveOpenCarapaceConfig,
  resolveOpenCarapaceConfigPath,
} from "../../src/config/index";
import { createDefaultOrchestrator } from "../../src/index";
import type { OpenCarapaceConfig } from "../../src/config/types";

describe("config serialization", () => {
  test("renderOpenCarapaceConfigToml serializes acp_command and acp_args", () => {
    const config: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "codex",
        language: "en",
        port: 3000,
        gateway_port: 3010,
        session_store_file: "sessions.json",
        project_root_dir: "/tmp/projects",
      },
      agents: {
        codex: {
          enabled: true,
          acp_command: "codex-acp",
          acp_args: ["--flag", "value"],
          cli_command: "codex",
          cli_args: ["exec", "{{prompt}}"],
        },
        claude_code: {
          enabled: true,
          acp_command: "claude-acp",
          acp_args: [],
          cli_command: "claude",
          cli_args: ["-p", "{{prompt}}"],
        },
      },
    };

    const toml = renderOpenCarapaceConfigToml(config);
    expect(toml).toContain("acp_command");
    expect(toml).toContain('"codex-acp"');
    expect(toml).toContain('"claude-acp"');
    expect(toml).toContain('"--flag"');
    expect(toml).toContain('"value"');
  });

  test("defaultOpenCarapaceConfig does not set acp_command on either agent", () => {
    const config = defaultOpenCarapaceConfig();
    expect(config.agents?.codex?.acp_command).toBeUndefined();
    expect(config.agents?.claude_code?.acp_command).toBeUndefined();
  });

  test("loadOpenCarapaceConfig round-trips acp fields", () => {
    const tmpPath = path.join(os.tmpdir(), `oc-tui-test-${Date.now()}.toml`);
    const original: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "codex",
        language: "zh",
        port: 3001,
        gateway_port: 3011,
        session_store_file: "sessions.json",
        project_root_dir: "/tmp/projects",
      },
      agents: {
        codex: {
          enabled: true,
          acp_command: "my-codex-acp",
          acp_args: ["--model", "gpt-4"],
          cli_command: "codex",
          cli_args: [],
        },
      },
    };

    saveOpenCarapaceConfig(original, { path: tmpPath });
    const loaded = loadOpenCarapaceConfig({ path: tmpPath });

    expect(loaded.agents?.codex?.acp_command).toBe("my-codex-acp");
    expect(loaded.agents?.codex?.acp_args).toEqual(["--model", "gpt-4"]);
    expect(loaded.runtime?.language).toBe("zh");
    expect(loaded.runtime?.port).toBe(3001);
  });
});

describe("createDefaultOrchestrator with acp_command", () => {
  test("registers AcpAgentAdapter for codex when only acp_command is set (no cli_command)", () => {
    const tmpPath = path.join(os.tmpdir(), `oc-acp-test-${Date.now()}.toml`);
    const config: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "codex",
        session_store_file: tmpPath + ".sessions.json",
        project_root_dir: "/tmp/projects",
        port: 3000,
        gateway_port: 3010,
      },
      agents: {
        codex: {
          enabled: true,
          acp_command: "fake-codex-acp",
          acp_args: [],
          // deliberately no cli_command
        },
      },
    };

    const orchestrator = createDefaultOrchestrator({ config, configPath: tmpPath });
    const agents = orchestrator.registry.list();
    expect(agents.length).toBeGreaterThan(0);
    const codexAgent = agents.find((a) => a.id === "codex");
    expect(codexAgent).toBeDefined();
  });

  test("registers AcpAgentAdapter for claude-code when only acp_command is set", () => {
    const tmpPath = path.join(os.tmpdir(), `oc-acp-claude-test-${Date.now()}.toml`);
    const config: OpenCarapaceConfig = {
      runtime: {
        default_agent_id: "claude-code",
        session_store_file: tmpPath + ".sessions.json",
        project_root_dir: "/tmp/projects",
        port: 3000,
        gateway_port: 3010,
      },
      agents: {
        codex: {
          enabled: false,
        },
        claude_code: {
          enabled: true,
          acp_command: "fake-claude-acp",
          acp_args: [],
          // deliberately no cli_command
        },
      },
    };

    const orchestrator = createDefaultOrchestrator({ config, configPath: tmpPath });
    const agents = orchestrator.registry.list();
    expect(agents.length).toBeGreaterThan(0);
    const claudeAgent = agents.find((a) => a.id === "claude-code");
    expect(claudeAgent).toBeDefined();
  });
});
