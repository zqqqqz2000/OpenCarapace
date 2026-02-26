export const TELEGRAM_RENAME_PICK_CALLBACK_PREFIX = "oc:rename:";
export const TELEGRAM_RENAME_PICK_META_TOKEN = "telegram_rename_pick_token";

export function buildTelegramRenamePickCallbackData(token: string): string {
  const normalized = token.trim();
  return normalized ? `${TELEGRAM_RENAME_PICK_CALLBACK_PREFIX}${normalized}` : "";
}

export function parseTelegramRenamePickCallbackData(
  value: string,
): { token: string } | null {
  const normalized = value.trim();
  if (!normalized.startsWith(TELEGRAM_RENAME_PICK_CALLBACK_PREFIX)) {
    return null;
  }
  const token = normalized.slice(TELEGRAM_RENAME_PICK_CALLBACK_PREFIX.length).trim();
  if (!token) {
    return null;
  }
  return { token };
}
