import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CommandTool, ToolExecutionResult } from "../core/tools.js";

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value ?? "");
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function parseGrepArgs(args: string[]): {
  pattern: string;
  targetPath?: string;
  limit: number;
  error?: string;
} {
  const patternTokens: string[] = [];
  let targetPath: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]?.trim();
    if (!arg) {
      continue;
    }
    if (arg === "--path") {
      targetPath = args[i + 1]?.trim();
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = parsePositiveInt(args[i + 1], 20, 80);
      i += 1;
      continue;
    }
    patternTokens.push(arg);
  }

  const pattern = patternTokens.join(" ").trim();
  if (!pattern) {
    const result = {
      pattern: "",
      limit,
      error: 'Usage: /grep "<pattern>" [--path <dir-or-file>] [--limit <n>]',
    };
    if (targetPath) {
      return {
        ...result,
        targetPath,
      };
    }
    return result;
  }

  const result = {
    pattern,
    limit,
  };
  if (targetPath) {
    return {
      ...result,
      targetPath,
    };
  }
  return result;
}

function normalizeResultLine(line: string, cwd: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return trimmed;
  }
  const match = /^(.+?):(\d+):(.*)$/.exec(trimmed);
  if (!match) {
    return clipText(trimmed, 240);
  }
  const rawPath = match[1] ?? "";
  const lineNo = match[2] ?? "0";
  const rawContent = match[3] ?? "";
  const content = clipText(rawContent.trim(), 200);
  const displayPath = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) || rawPath : rawPath;
  return `${displayPath}:${lineNo}: ${content}`;
}

function runProcess(command: string, args: string[]): {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
} {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      missing: true,
    };
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: false,
  };
}

function buildNoMatchText(pattern: string, targetPath: string): string {
  return [
    "No grep matches found.",
    `- pattern: ${pattern}`,
    `- path: ${targetPath}`,
  ].join("\n");
}

export function createGrepWorkspaceTool(params?: {
  defaultRootDir?: string;
}): CommandTool {
  const defaultRootDir = path.resolve(params?.defaultRootDir ?? process.cwd());

  return {
    id: "openclaw.grep.workspace",
    name: "grep",
    aliases: ["rg"],
    description: "Search workspace text with ripgrep-style output.",
    execute(context): ToolExecutionResult {
      const parsed = parseGrepArgs(context.args);
      if (parsed.error) {
        return {
          text: parsed.error,
        };
      }

      const targetPath = path.resolve(defaultRootDir, parsed.targetPath ?? ".");

      const rgArgs = [
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--color",
        "never",
        "--max-count",
        String(parsed.limit),
        "--",
        parsed.pattern,
        targetPath,
      ];
      const rg = runProcess("rg", rgArgs);
      let stdout = rg.stdout;
      let stderr = rg.stderr;
      let status = rg.code;
      let matched = rg.ok;

      if (rg.missing) {
        const grepArgs = [
          "-R",
          "-n",
          "-m",
          String(parsed.limit),
          "--",
          parsed.pattern,
          targetPath,
        ];
        const grep = runProcess("grep", grepArgs);
        stdout = grep.stdout;
        stderr = grep.stderr;
        status = grep.code;
        matched = grep.ok;
      }

      const lines = stdout
        .split("\n")
        .map((line) => normalizeResultLine(line, defaultRootDir))
        .filter(Boolean)
        .slice(0, parsed.limit);

      if (lines.length === 0) {
        if (status === 1 || !stderr.trim()) {
          return {
            text: buildNoMatchText(parsed.pattern, targetPath),
          };
        }
        return {
          text: [
            "grep failed.",
            `- pattern: ${parsed.pattern}`,
            `- path: ${targetPath}`,
            `- error: ${stderr.trim()}`,
          ].join("\n"),
        };
      }

      const body = lines.map((line, index) => `${index + 1}. ${line}`);
      const summary = [`Grep matches (${lines.length})`, ...body];
      if (!matched) {
        summary.push(`Note: search exited with code ${String(status ?? "unknown")}.`);
      }
      return {
        text: summary.join("\n"),
      };
    },
  };
}
