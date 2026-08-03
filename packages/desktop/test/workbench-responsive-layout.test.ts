import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const layoutCss = readFileSync(
  fileURLToPath(new URL("../src/renderer/src/styles/layout.css", import.meta.url)),
  "utf8",
);
const panelCss = readFileSync(fileURLToPath(new URL("../src/renderer/src/styles/panel.css", import.meta.url)), "utf8");

describe("workbench responsive layout", () => {
  it("makes the workspace a size container so narrow-window rules can key off its actual width", () => {
    expect(layoutCss).toMatch(/\.workspace\s*\{[^}]*container-type:\s*inline-size;/s);
    expect(layoutCss).toMatch(/\.workspace\s*\{[^}]*container-name:\s*workspace;/s);
  });

  it("switches the workbench panel to an overlay above the chat when the workspace is narrow", () => {
    const containerRule = layoutCss.match(/@container workspace \(max-width: 719px\)\s*\{([\s\S]*?)\n\}/);
    expect(containerRule).not.toBeNull();
    const body = containerRule?.[1] ?? "";
    expect(body).toContain(".workspace > .workbench-panel {");
    expect(body).toContain("position: absolute;");
    expect(body).toContain("z-index: var(--stack-workbench-overlay);");
    expect(body).toContain("grid-template-columns: minmax(0, 1fr);");
  });

  it("keeps the panel width bounded by the JS-provided workspace-relative maximum", () => {
    expect(panelCss).toContain("max-width: var(--workbench-max-size, 80vw);");
    expect(panelCss).toContain("min-width: var(--layout-workbench-min-width);");
  });
});
