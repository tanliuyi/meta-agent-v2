import { describe, expect, it } from "vitest";
import {
  findMatches,
  groupMatchesByLine,
  splitLineByMatches,
  splitTokensByMatches,
} from "../src/renderer/src/components/panel/files/file-find.ts";
import {
  calculateMinimapLayout,
  extractMinimapSegments,
  getMinimapCharIndex,
  getMinimapCharXOffsets,
  getMinimapContentWidth,
  getMinimapLineAt,
  getMinimapLineColumns,
} from "../src/renderer/src/components/panel/files/file-minimap.tsx";

const content = "const foo = 1;\nfoo(2);\n// Foo bar\n";

describe("findMatches", () => {
  it("按行定位全部匹配（不区分大小写）", () => {
    expect(findMatches(content, "foo")).toEqual([
      { line: 0, start: 6, end: 9 },
      { line: 1, start: 0, end: 3 },
      { line: 2, start: 3, end: 6 }, // // Foo bar 中的 Foo
    ]);
  });

  it("不跨行匹配", () => {
    expect(findMatches("a\nb", "a\nb")).toEqual([]);
  });

  it("区分大小写", () => {
    expect(findMatches(content, "foo", true)).toHaveLength(2);
    expect(findMatches(content, "Foo", true)).toEqual([{ line: 2, start: 3, end: 6 }]);
  });

  it("空查询返回空数组；无结果返回空数组", () => {
    expect(findMatches(content, "")).toEqual([]);
    expect(findMatches(content, "missing")).toEqual([]);
  });

  it("一行内多个匹配", () => {
    expect(findMatches("foo foo", "foo")).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
    ]);
  });
});

describe("extractMinimapSegments", () => {
  it("把 shiki 全局偏移转为行内偏移并提取双主题颜色", () => {
    // 对齐 shiki codeToTokens 输出：token.offset 是文件全局偏移。
    const tokens = [
      [
        { content: "const ", offset: 0, color: "#000" },
        { content: "foo", offset: 6, color: "#795e26", htmlStyle: { "--shiki-dark": "#dcdcaa" } },
      ],
      [
        { content: "  ", offset: 14, color: "#000" },
        { content: "foo", offset: 16, color: "#795e26", htmlStyle: { "--shiki-dark": "#dcdcaa" } },
      ],
    ];
    const segments = extractMinimapSegments(tokens as never);
    expect(segments[0]).toEqual([
      { start: 0, end: 5, light: "#000", dark: null },
      { start: 6, end: 9, light: "#795e26", dark: "#dcdcaa" },
    ]);
    // 第二行从 0 重新开始（行内偏移），不受全局 offset 影响。
    expect(segments[1][0]).toMatchObject({ start: 2, end: 5 });
  });

  it("空行返回空数组", () => {
    expect(extractMinimapSegments([[]] as never)).toEqual([[]]);
  });

  it("跳过纯空白 token 并保留字符的原始列位置", () => {
    const tokens = [[{ content: "  foo bar  ", offset: 20, color: "#000" }]];
    expect(extractMinimapSegments(tokens as never)).toEqual([
      [
        { start: 2, end: 5, light: "#000", dark: null },
        { start: 6, end: 9, light: "#000", dark: null },
      ],
    ]);
  });
});

describe("minimap layout", () => {
  it("长文件滚到底部时内容窗口和滑块都贴合底部", () => {
    const layout = calculateMinimapLayout({
      lines: 1000,
      height: 400,
      scrollTop: 19600,
      scrollHeight: 20000,
      clientHeight: 400,
    });
    expect(layout.contentOffset).toBe(1600);
    expect(layout.sliderTop + layout.sliderHeight).toBe(400);
  });

  it("minimap 能容纳全文时，滑块按可见代码行数缩放并停留在内容区域", () => {
    const layout = calculateMinimapLayout({
      lines: 115,
      height: 870,
      scrollTop: 0,
      scrollHeight: 2279,
      clientHeight: 858,
    });
    expect(layout.sliderHeight).toBeCloseTo(86.58, 1);
    expect(layout.sliderTravel).toBeCloseTo(143.42, 1);
  });

  it("极长文件仍保留最小可拖动滑块", () => {
    const layout = calculateMinimapLayout({
      lines: 100000,
      height: 400,
      scrollTop: 0,
      scrollHeight: 20000000,
      clientHeight: 400,
    });
    expect(layout.sliderHeight).toBe(8);
  });

  it("点击坐标会计入当前 minimap 内容偏移并限制到文件范围", () => {
    expect(getMinimapLineAt(20, 400, 1000, 1600)).toBe(810);
    expect(getMinimapLineAt(400, 400, 1000, 1600)).toBe(999);
  });

  it("空文件时布局为零", () => {
    const layout = calculateMinimapLayout({
      lines: 0,
      height: 400,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 400,
    });
    expect(layout).toEqual({ contentOffset: 0, scrollRange: 0, sliderHeight: 0, sliderTop: 0, sliderTravel: 0 });
  });

  it("全文在视口内（无滚动范围）时滑块覆盖内容且不移动", () => {
    const layout = calculateMinimapLayout({
      lines: 5,
      height: 400,
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 400,
    });
    expect(layout.contentOffset).toBe(0);
    expect(layout.sliderHeight).toBe(10);
    expect(layout.sliderTop).toBe(0);
    expect(layout.sliderTravel).toBe(0);
  });

  it("minimap 内容短于面板时内容顶部对齐且滑块不越过内容区域", () => {
    const layout = calculateMinimapLayout({
      lines: 50,
      height: 400,
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    expect(layout.contentOffset).toBe(0);
    expect(layout.sliderTop).toBeCloseTo(60, 5);
    expect(layout.sliderTop + layout.sliderHeight).toBeLessThanOrEqual(100);
  });
});

describe("minimap char layout", () => {
  it("tab stop 按 4 列展开并保留行首缩进", () => {
    // 左侧 2px gutter：'a' 在 2，tab 从 3 起推进 3 列，'b' 在 6。
    expect(getMinimapCharXOffsets("a\tb", 20)).toEqual([2, 3, 6]);
    expect(getMinimapCharXOffsets("\tabc", 20)).toEqual([2, 6, 7, 8]);
  });

  it("全角字符占 2 像素宽度", () => {
    expect(getMinimapCharXOffsets("a你b", 20)).toEqual([2, 3, 5]);
  });

  it("超过 minimap 宽度时裁剪后续字符", () => {
    expect(getMinimapCharXOffsets("abcdefghijkl", 12)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // 全角字符第二个像素越界时整字符不绘制（对齐 _renderLine 的 dx > maxDx 检查）。
    expect(getMinimapCharXOffsets("abcdefgh你", 10)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("空文本或零宽度返回空数组", () => {
    expect(getMinimapCharXOffsets("", 20)).toEqual([]);
    expect(getMinimapCharXOffsets("ab", 0)).toEqual([]);
  });
});

describe("minimap char index", () => {
  it("ASCII 映射到预烘焙字符表", () => {
    expect(getMinimapCharIndex(32)).toBe(0);
    expect(getMinimapCharIndex(65)).toBe(33);
    expect(getMinimapCharIndex(126)).toBe(94);
  });

  it("表外字符按 96 取模回绕（对齐 getCharIndex 的 fontScale<=2 行为）", () => {
    expect(getMinimapCharIndex(0x4f60)).toBe(32);
    expect(getMinimapCharIndex(65533)).toBe(29);
  });
});

describe("minimap content width", () => {
  it("按行视觉列宽计算（tab stop=4、全角=2、忽略行尾空白）", () => {
    expect(getMinimapLineColumns("abc")).toBe(5);
    expect(getMinimapLineColumns("\tfoo")).toBe(9);
    expect(getMinimapLineColumns("a\tb")).toBe(7);
    expect(getMinimapLineColumns("你")).toBe(4);
    expect(getMinimapLineColumns("  foo  ")).toBe(7);
    expect(getMinimapLineColumns("")).toBe(2);
  });

  it("短文件封底到 56px，超长行封顶到 96px", () => {
    expect(getMinimapContentWidth(["abc"])).toBe(56);
    expect(getMinimapContentWidth([])).toBe(56);
    expect(getMinimapContentWidth(["a".repeat(200)])).toBe(96);
  });

  it("多行取最大视觉列宽，行尾空白不撑宽", () => {
    expect(getMinimapContentWidth(["short", "x".repeat(60)])).toBe(62);
    expect(getMinimapContentWidth(["short", "你".repeat(60)])).toBe(96);
    expect(getMinimapContentWidth(["x".repeat(30), "y".repeat(80)])).toBe(82);
    expect(getMinimapContentWidth(["x".repeat(60) + " ".repeat(500)])).toBe(62);
  });
});

describe("groupMatchesByLine", () => {
  it("按行分组", () => {
    const grouped = groupMatchesByLine([
      { line: 0, start: 1, end: 2 },
      { line: 2, start: 0, end: 1 },
      { line: 0, start: 5, end: 6 },
    ]);
    expect(grouped.get(0)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
    expect(grouped.get(1)).toBeUndefined();
  });
});

describe("splitLineByMatches", () => {
  it("拆分普通文本并标记当前匹配", () => {
    const matches = [
      { line: 0, start: 1, end: 2 },
      { line: 0, start: 4, end: 5 },
    ];
    expect(splitLineByMatches("abcde", matches, 4)).toEqual([
      { text: "a", match: false, active: false },
      { text: "b", match: true, active: false },
      { text: "cd", match: false, active: false },
      { text: "e", match: true, active: true },
    ]);
  });

  it("无匹配时返回整段", () => {
    expect(splitLineByMatches("abc", [], undefined)).toEqual([{ text: "abc", match: false, active: false }]);
  });
});

describe("splitTokensByMatches", () => {
  const tokens = [
    { content: "const ", offset: 0 },
    { content: "foo", offset: 6 },
    { content: " = 1;", offset: 9 },
  ];

  it("跨 token 匹配时拆分并保留 token 引用", () => {
    const matches = [{ line: 0, start: 6, end: 9 }];
    const segments = splitTokensByMatches(tokens, matches, 6);
    expect(segments).toEqual([
      { text: "const ", match: false, active: false, token: tokens[0] },
      { text: "foo", match: true, active: true, token: tokens[1] },
      { text: " = 1;", match: false, active: false, token: tokens[2] },
    ]);
  });

  it("匹配落在单个 token 内部时拆分该 token", () => {
    const matches = [{ line: 0, start: 7, end: 8 }];
    const segments = splitTokensByMatches(tokens, matches, 7);
    expect(segments.map((segment) => segment.text)).toEqual(["const ", "f", "o", "o", " = 1;"]);
    expect(segments.filter((segment) => segment.match)).toHaveLength(1);
  });

  it("无匹配时原样返回", () => {
    const segments = splitTokensByMatches(tokens, [], undefined);
    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => !segment.match)).toBe(true);
  });
});
