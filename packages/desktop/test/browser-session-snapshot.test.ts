import { describe, expect, it } from "vitest";
import {
  browserSessionSnapshot,
  normalizeBrowserSessionSnapshot,
} from "../src/renderer/src/components/panel/browser/browser-session-snapshot.ts";

describe("browserSessionSnapshot", () => {
  it("过滤空白 URL 后按可持久化标签重新映射活动索引", () => {
    expect(
      browserSessionSnapshot(
        [
          { url: "", active: false },
          { url: "https://a.example/", active: true },
          { url: "https://b.example/", active: false },
        ],
        0,
      ),
    ).toEqual({ urls: ["https://a.example/", "https://b.example/"], activeIndex: 0 });
  });

  it("过滤持久化空 URL 时按原始活动项重映射索引", () => {
    expect(
      normalizeBrowserSessionSnapshot({ urls: ["", "https://a.example/", "https://b.example/"], activeIndex: 1 }),
    ).toEqual({
      urls: ["https://a.example/", "https://b.example/"],
      activeIndex: 0,
    });
  });

  it("没有活动 URL 时把旧索引钳制到当前可持久化标签范围", () => {
    expect(browserSessionSnapshot([{ url: "https://a.example/", active: false }], 8)).toEqual({
      urls: ["https://a.example/"],
      activeIndex: 0,
    });
  });
});
