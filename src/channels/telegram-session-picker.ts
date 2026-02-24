export const TELEGRAM_SESSION_PICK_CALLBACK_PREFIX = "oc:sess:";
export const TELEGRAM_SESSION_PICK_META_TOKEN = "telegram_session_pick_token";
export const TELEGRAM_SESSION_PICK_META_SESSION_ID = "telegram_session_pick_session_id";
export const TELEGRAM_SESSION_PICK_META_SESSION_NAME = "telegram_session_pick_session_name";

export function buildTelegramSessionPickCallbackData(token: string): string {
  const normalized = token.trim();
  return normalized ? `${TELEGRAM_SESSION_PICK_CALLBACK_PREFIX}${normalized}` : "";
}

export function parseTelegramSessionPickCallbackData(
  value: string,
): { token: string } | null {
  const normalized = value.trim();
  if (!normalized.startsWith(TELEGRAM_SESSION_PICK_CALLBACK_PREFIX)) {
    return null;
  }
  const token = normalized.slice(TELEGRAM_SESSION_PICK_CALLBACK_PREFIX.length).trim();
  if (!token) {
    return null;
  }
  return { token };
}
