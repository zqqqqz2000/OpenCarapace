export const TELEGRAM_PROJECT_PICK_CALLBACK_PREFIX = "oc:proj:";
export const TELEGRAM_PROJECT_PICK_META_TOKEN = "telegram_project_pick_token";

export function buildTelegramProjectPickCallbackData(token: string): string {
  const normalized = token.trim();
  return normalized ? `${TELEGRAM_PROJECT_PICK_CALLBACK_PREFIX}${normalized}` : "";
}

export function parseTelegramProjectPickCallbackData(
  value: string,
): { token: string } | null {
  const normalized = value.trim();
  if (!normalized.startsWith(TELEGRAM_PROJECT_PICK_CALLBACK_PREFIX)) {
    return null;
  }
  const token = normalized.slice(TELEGRAM_PROJECT_PICK_CALLBACK_PREFIX.length).trim();
  if (!token) {
    return null;
  }
  return { token };
}
