import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  defaultOpenCarapaceConfig,
  loadOpenCarapaceConfig,
  parseConfigValue,
  resolveOpenCarapaceConfigPath,
  saveOpenCarapaceConfig,
  setConfigValueByPath,
} from "../../src/config/index.js";

describe("config file", () => {
  test("resolves default config path under ~/.config/opencarapace", () => {
    const resolved = resolveOpenCarapaceConfigPath();
    expect(resolved).toContain(path.join(".config", "opencarapace", "config.toml"));
  });

  test("expands ~ in explicit config path", () => {
    const resolved = resolveOpenCarapaceConfigPath("~/tmp/opencarapace.toml");
    expect(resolved).toBe(path.join(os.homedir(), "tmp", "opencarapace.toml"));
  });

  test("saves and loads config toml", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-config-test-"));
    const filePath = path.join(dir, "config.toml");

    const config = defaultOpenCarapaceConfig();
    config.channels = {
      ...(config.channels ?? {}),
      telegram: {
        enabled: true,
        token_file: "./telegram.token",
        allowed_chat_ids: ["10001", "10002"],
      },
    };
    saveOpenCarapaceConfig(config, { path: filePath });

    const loaded = loadOpenCarapaceConfig({ path: filePath, strict: true });
    expect(loaded.channels?.telegram?.enabled).toBeTrue();
    expect(loaded.channels?.telegram?.token_file).toBe("./telegram.token");
    expect(loaded.channels?.telegram?.allowed_chat_ids).toEqual(["10001", "10002"]);
  });

  test("updates nested values and parses scalar/list forms", () => {
    const config = defaultOpenCarapaceConfig();
    setConfigValueByPath(config, "channels.telegram.enabled", parseConfigValue("true"));
    setConfigValueByPath(config, "channels.telegram.allowed_chat_ids", parseConfigValue("a,b,c"));
    setConfigValueByPath(config, "runtime.gateway_port", parseConfigValue("3020"));

    expect(config.channels?.telegram?.enabled).toBeTrue();
    expect(config.channels?.telegram?.allowed_chat_ids).toEqual(["a", "b", "c"]);
    expect(config.runtime?.gateway_port).toBe(3020);
  });

  test("default config sets project root under ~/Documents", () => {
    const config = defaultOpenCarapaceConfig();
    expect(config.runtime?.project_root_dir).toBe(path.resolve(os.homedir(), "Documents"));
  });

  test("throws on invalid toml by default, can opt out via strict=false", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-config-parse-"));
    const filePath = path.join(dir, "broken.toml");
    writeFileSync(filePath, "[runtime\nport = 3000", "utf-8");

    expect(() => loadOpenCarapaceConfig({ path: filePath })).toThrow(/failed to parse config/i);
    expect(loadOpenCarapaceConfig({ path: filePath, strict: false })).toEqual({});
  });
});
