import { describe, expect, test } from "bun:test";
import { ReadabilityPolicy } from "../../src/core/ux-policy";

describe("ReadabilityPolicy", () => {
  test("clips long output and controls line count", () => {
    const policy = new ReadabilityPolicy({ maxChars: 120, maxLines: 3 });
    const text = "第一句。第二句。第三句。第四句。第五句。第六句。第七句。";
    const normalized = policy.normalize(text);

    expect(normalized.length).toBeLessThanOrEqual(120);
    expect(normalized.split("\n").length).toBeLessThanOrEqual(3);
  });

  test("returns fallback when empty", () => {
    const policy = new ReadabilityPolicy();
    expect(policy.normalize("\n\n")).toContain("暂无可读结果");
  });
});
