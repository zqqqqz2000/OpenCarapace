import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { resolveSecretValue, resolveStringListFromFile } from "../../src/config/secrets.js";

describe("config secrets", () => {
  test("reads secret from *_file path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-secret-test-"));
    const tokenFile = path.join(dir, "token.txt");
    writeFileSync(tokenFile, "token-abc\n", "utf-8");

    const token = resolveSecretValue({
      file: "./token.txt",
      configFilePath: path.join(dir, "config.toml"),
    });

    expect(token).toBe("token-abc");
  });

  test("reads secret from @file inline syntax", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-secret-inline-"));
    const secretFile = path.join(dir, "inline.secret");
    writeFileSync(secretFile, "s3cr3t\n", "utf-8");

    const value = resolveSecretValue({
      value: "@file:./inline.secret",
      configFilePath: path.join(dir, "config.toml"),
    });

    expect(value).toBe("s3cr3t");
  });

  test("reads list from file fallback", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-carapace-secret-list-"));
    const listFile = path.join(dir, "args.txt");
    writeFileSync(listFile, "exec\n{{prompt}}\n", "utf-8");

    const values = resolveStringListFromFile({
      file: "./args.txt",
      configFilePath: path.join(dir, "config.toml"),
    });

    expect(values).toEqual(["exec", "{{prompt}}"]);
  });
});
