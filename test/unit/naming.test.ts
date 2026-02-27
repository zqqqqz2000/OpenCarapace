import { describe, expect, test } from "bun:test";
import { assertInjectableId, isInjectableId } from "../../src/core/naming";

describe("injectable naming", () => {
  test("accepts vendor.scope.capability style ids", () => {
    expect(isInjectableId("codex.progress.notifier")).toBeTrue();
    expect(isInjectableId("core.memory.session")).toBeTrue();
    expect(isInjectableId("vendor.domain.feature.alpha")).toBeTrue();
  });

  test("rejects malformed ids", () => {
    expect(isInjectableId("memory")).toBeFalse();
    expect(isInjectableId("bad..name")).toBeFalse();
    expect(isInjectableId("Bad.case.name")).toBeFalse();
    expect(isInjectableId("a.b")).toBeFalse();
  });

  test("throws with format hint for invalid id", () => {
    expect(() => assertInjectableId("skill", "bad")).toThrow(/vendor\.scope\.capability/i);
  });

  test("supports tool kind validation", () => {
    expect(() => assertInjectableId("tool", "openclaw.skill.lookup")).not.toThrow();
  });
});
