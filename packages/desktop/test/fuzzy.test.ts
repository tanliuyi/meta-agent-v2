import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyMatchIndices } from "../src/main/files/fuzzy.ts";

describe("fuzzyMatch", () => {
  it("精确子串得分高于分散子序列", () => {
    const exact = fuzzyMatch("build", "build-config.ts");
    const spread = fuzzyMatch("build", "b-uild.ts");
    expect(exact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(exact!).toBeGreaterThan(spread!);
  });

  it("词首匹配加分：连续匹配优先于分散匹配", () => {
    const a = fuzzyMatch("ab", "aXbYab");
    const b = fuzzyMatch("ab", "xab");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!).toBeGreaterThan(a!);
  });

  it("不区分大小写", () => {
    expect(fuzzyMatch("README", "readme.md")).not.toBeNull();
    expect(fuzzyMatch("readme", "README.md")).not.toBeNull();
  });

  it("非子序列返回 null", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
    expect(fuzzyMatch("abc", "ab")).toBeNull();
    expect(fuzzyMatch("", "anything")).toBeNull();
  });

  it("连续子串（含路径分隔词首）匹配优先", () => {
    const camel = fuzzyMatch("fT", "first-target.ts");
    const spread = fuzzyMatch("fT", "firstTarget.ts");
    expect(camel).not.toBeNull();
    expect(spread).not.toBeNull();
  });

  it("更靠前的匹配得分更高", () => {
    const early = fuzzyMatch("app", "app-config.ts");
    const late = fuzzyMatch("app", "src-app.ts");
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(early!).toBeGreaterThan(late!);
  });
});

describe("fuzzyMatchIndices", () => {
  it("返回正向贪心的匹配下标", () => {
    expect(fuzzyMatchIndices("ft", "first-target.ts")).toEqual([0, 4]);
  });

  it("无匹配返回空数组", () => {
    expect(fuzzyMatchIndices("xyz", "abc")).toEqual([]);
  });
});
