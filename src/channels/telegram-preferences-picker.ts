export type TelegramSandboxOption =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "clear";

export type TelegramModelOption = "gpt-5" | "gpt-5.1" | "clear" | "custom";

export type TelegramDepthOption = "low" | "medium" | "high" | "clear";

type TelegramPreferenceCommand = {
  commandText: string;
  ackText: string;
};

const TELEGRAM_SANDBOX_CALLBACK_PREFIX = "oc:sandbox:";
const TELEGRAM_MODEL_CALLBACK_PREFIX = "oc:model:";
const TELEGRAM_DEPTH_CALLBACK_PREFIX = "oc:depth:";

function normalizePayload(value: string, prefix: string): string | undefined {
  const normalized = value.trim();
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  const payload = normalized.slice(prefix.length).trim().toLowerCase();
  return payload || undefined;
}

export function buildTelegramSandboxCallbackData(mode: TelegramSandboxOption): string {
  return `${TELEGRAM_SANDBOX_CALLBACK_PREFIX}${mode}`;
}

export function parseTelegramSandboxCallbackData(
  value: string,
): { mode: TelegramSandboxOption } | null {
  const payload = normalizePayload(value, TELEGRAM_SANDBOX_CALLBACK_PREFIX);
  if (
    payload !== "read-only" &&
    payload !== "workspace-write" &&
    payload !== "danger-full-access" &&
    payload !== "clear"
  ) {
    return null;
  }
  return { mode: payload };
}

export function buildTelegramModelCallbackData(model: TelegramModelOption): string {
  return `${TELEGRAM_MODEL_CALLBACK_PREFIX}${model}`;
}

export function parseTelegramModelCallbackData(
  value: string,
): { model: TelegramModelOption } | null {
  const payload = normalizePayload(value, TELEGRAM_MODEL_CALLBACK_PREFIX);
  if (
    payload !== "gpt-5" &&
    payload !== "gpt-5.1" &&
    payload !== "clear" &&
    payload !== "custom"
  ) {
    return null;
  }
  return { model: payload };
}

export function buildTelegramDepthCallbackData(depth: TelegramDepthOption): string {
  return `${TELEGRAM_DEPTH_CALLBACK_PREFIX}${depth}`;
}

export function parseTelegramDepthCallbackData(
  value: string,
): { depth: TelegramDepthOption } | null {
  const payload = normalizePayload(value, TELEGRAM_DEPTH_CALLBACK_PREFIX);
  if (payload !== "low" && payload !== "medium" && payload !== "high" && payload !== "clear") {
    return null;
  }
  return { depth: payload };
}

export function resolveTelegramPreferenceCommandFromCallbackData(
  value: string,
): TelegramPreferenceCommand | null {
  const sandbox = parseTelegramSandboxCallbackData(value);
  if (sandbox) {
    if (sandbox.mode === "clear") {
      return {
        commandText: "/sandbox clear",
        ackText: "sandbox cleared",
      };
    }
    return {
      commandText: `/sandbox ${sandbox.mode}`,
      ackText: `sandbox: ${sandbox.mode}`,
    };
  }

  const model = parseTelegramModelCallbackData(value);
  if (model) {
    if (model.model === "clear") {
      return {
        commandText: "/model clear",
        ackText: "model cleared",
      };
    }
    if (model.model === "custom") {
      return {
        commandText: "/model",
        ackText: "send /model <name>",
      };
    }
    return {
      commandText: `/model ${model.model}`,
      ackText: `model: ${model.model}`,
    };
  }

  const depth = parseTelegramDepthCallbackData(value);
  if (depth) {
    if (depth.depth === "clear") {
      return {
        commandText: "/depth clear",
        ackText: "depth cleared",
      };
    }
    return {
      commandText: `/depth ${depth.depth}`,
      ackText: `depth: ${depth.depth}`,
    };
  }

  return null;
}
