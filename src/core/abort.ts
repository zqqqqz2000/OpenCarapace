export class TurnAbortedError extends Error {
  constructor(message = "turn aborted") {
    super(message);
    this.name = "TurnAbortedError";
  }
}

export function isTurnAbortedError(error: unknown): boolean {
  if (error instanceof TurnAbortedError) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

export function toTurnAbortedError(
  reason: unknown,
  fallback = "turn aborted",
): TurnAbortedError {
  if (reason instanceof TurnAbortedError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new TurnAbortedError(reason.message || fallback);
  }
  if (typeof reason === "string" && reason.trim()) {
    return new TurnAbortedError(reason.trim());
  }
  return new TurnAbortedError(fallback);
}

