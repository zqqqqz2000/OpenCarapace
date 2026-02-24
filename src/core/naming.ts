export type InjectableKind = "skill" | "hook" | "tool";

const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 6;

export function injectableIdFormatHint(): string {
  return "use dot-separated lowercase segments like vendor.scope.capability (3-6 segments, [a-z][a-z0-9-]*)";
}

export function isInjectableId(id: string): boolean {
  if (!id) {
    return false;
  }

  const segments = id.split(".");
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
    return false;
  }

  return segments.every((segment) => SEGMENT_RE.test(segment));
}

export function assertInjectableId(kind: InjectableKind, id: string): void {
  if (isInjectableId(id)) {
    return;
  }
  throw new Error(`invalid ${kind} id "${id}": ${injectableIdFormatHint()}`);
}
