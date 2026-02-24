export type TurnDecisionAction = "steer" | "stack";

const TURN_DECISION_CALLBACK_PREFIX = "oc:turn:";
const TURN_DECISION_TOKEN_RE = /^[a-zA-Z0-9-]{8,80}$/;

export const TURN_DECISION_META_ACTION = "__oc_turn_decision_action";
export const TURN_DECISION_META_TOKEN = "__oc_turn_decision_token";
export const TURN_DECISION_META_BYPASS = "__oc_turn_decision_bypass";
export const TURN_DECISION_META_FORCE_STEER = "__oc_turn_decision_force_steer";

export function buildTurnDecisionCallbackData(
  token: string,
  action: TurnDecisionAction,
): string {
  return `${TURN_DECISION_CALLBACK_PREFIX}${token}:${action}`;
}

export function parseTurnDecisionCallbackData(
  data: string,
): { token: string; action: TurnDecisionAction } | null {
  const normalized = data.trim();
  if (!normalized.startsWith(TURN_DECISION_CALLBACK_PREFIX)) {
    return null;
  }

  const payload = normalized.slice(TURN_DECISION_CALLBACK_PREFIX.length);
  const separator = payload.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const token = payload.slice(0, separator).trim();
  const actionRaw = payload.slice(separator + 1).trim();
  if (!TURN_DECISION_TOKEN_RE.test(token)) {
    return null;
  }
  if (actionRaw !== "steer" && actionRaw !== "stack") {
    return null;
  }
  return {
    token,
    action: actionRaw,
  };
}
