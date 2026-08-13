/**
 * 浏览器面板 webview 圆角裁切回归测试：
 * webview 常驻 body 下的 browser-session-runtime（fixed 对齐 .browser-viewport），
 * 不受 .panel-content 的 overflow:hidden 裁切；runtime 自身必须裁切 webview，
 * 且底部圆角与 Panel 内容区同步（非 darwin 16px / darwin 清零）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const browserPanelCss = readFileSync(
  fileURLToPath(new URL("../src/renderer/src/styles/browser-panel.css", import.meta.url)),
  "utf8",
);
const panelCss = readFileSync(fileURLToPath(new URL("../src/renderer/src/styles/panel.css", import.meta.url)), "utf8");

describe("browser panel webview corner clipping", () => {
  it("clips the visible session runtime with the panel bottom radius", () => {
    const rule = browserPanelCss.match(/^\.browser-session-runtime\s*\{([^}]*)\}/m);
    expect(rule).not.toBeNull();
    expect(rule?.[1] ?? "").toMatch(/overflow:\s*hidden/);
    expect(rule?.[1] ?? "").toMatch(/border-radius:\s*0\s+0\s+16px\s+16px/);
  });

  it("keeps the panel-level overflow visible contract (resize handle depends on it)", () => {
    // 修复只让 runtime 自身裁切，不改变 .workbench-panel 的 overflow:visible。
    expect(panelCss).toMatch(/\.workbench-panel\s*\{[^}]*overflow:\s*visible/s);
  });

  it("resets the runtime radius to 0 on darwin where the workbench panel has no radius", () => {
    const rule = browserPanelCss.match(
      /body:has\(\.app-frame\[data-platform="darwin"\]\)\s+\.browser-session-runtime\s*\{([^}]*)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule?.[1] ?? "").toMatch(/border-radius:\s*0\s*;/);
  });
});
