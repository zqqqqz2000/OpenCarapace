import fs from "node:fs";
import path from "node:path";

function normalizePath(rawPath: string, baseDir: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(baseDir, trimmed);
}

function readSecretFile(filePath: string): string | undefined {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(trimmed, "utf-8");
    const value = raw.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveInlineFileRef(value: string, baseDir: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("@file:")) {
    const refPath = trimmed.slice("@file:".length).trim();
    if (!refPath) {
      return undefined;
    }
    return readSecretFile(normalizePath(refPath, baseDir));
  }
  if (trimmed.startsWith("file://")) {
    const refPath = trimmed.slice("file://".length).trim();
    if (!refPath) {
      return undefined;
    }
    return readSecretFile(normalizePath(refPath, baseDir));
  }
  return trimmed || undefined;
}

export function resolveSecretValue(params: {
  value?: string;
  file?: string;
  configFilePath?: string;
}): string | undefined {
  const baseDir = path.dirname(params.configFilePath ?? process.cwd());
  const fileRef = params.file?.trim();
  if (fileRef) {
    return readSecretFile(normalizePath(fileRef, baseDir));
  }
  const inline = params.value?.trim();
  if (!inline) {
    return undefined;
  }
  return resolveInlineFileRef(inline, baseDir);
}

export function resolveStringListFromFile(params: {
  values?: string[];
  file?: string;
  configFilePath?: string;
}): string[] | undefined {
  const current = (params.values ?? []).map((item) => item.trim()).filter(Boolean);
  if (current.length > 0) {
    return current;
  }
  const secretParams = {} as {
    file?: string;
    configFilePath?: string;
  };
  if (params.file) {
    secretParams.file = params.file;
  }
  if (params.configFilePath) {
    secretParams.configFilePath = params.configFilePath;
  }
  const secret = resolveSecretValue(secretParams);
  if (!secret) {
    return undefined;
  }
  const parsed = secret
    .split(/\r?\n/)
    .flatMap((line) => line.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}
