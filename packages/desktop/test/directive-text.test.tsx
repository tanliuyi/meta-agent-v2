import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerDirectiveChip } from "../src/renderer/src/components/assistant-ui/composer-directive-chip.tsx";
import { DirectiveText, directiveDisplayLabel } from "../src/renderer/src/components/assistant-ui/directive-text.tsx";

const RenderDirectiveText = DirectiveText as unknown as FC<{ text: string }>;

describe("DirectiveText", () => {
  it("preserves whitespace in plain user text", () => {
    expect(renderToStaticMarkup(createElement(RenderDirectiveText, { text: "Inspect the current\nworkspace." }))).toBe(
      '<span class="whitespace-pre-wrap">Inspect the current\nworkspace.</span>',
    );
  });

  it("renders file directives with only the final path segment", () => {
    const markup = renderToStaticMarkup(
      createElement(RenderDirectiveText, {
        text: "Inspect :file[packages/desktop/src/renderer/src/components/assistant-ui/directive-text.tsx]{name=directive-text} before editing.",
      }),
    );

    expect(markup).toContain('data-slot="directive-text-chip"');
    expect(markup).toContain('data-directive-type="file"');
    expect(markup).toContain('data-directive-id="directive-text"');
    expect(markup).toContain('class="lucide lucide-file');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(">directive-text.tsx</span>");
    expect(markup).not.toContain(":file[packages/desktop");
  });

  it("keeps session mention titles verbatim even when they contain path separators", () => {
    const markup = renderToStaticMarkup(
      createElement(RenderDirectiveText, {
        text: "参考 :file[修复 A/B 模块的 bug]{name=/Users/tanliuyi/.pi/agent/sessions/--general--/a.jsonl} 继续。",
      }),
    );

    expect(markup).toContain('data-directive-id="/Users/tanliuyi/.pi/agent/sessions/--general--/a.jsonl"');
    expect(markup).toContain(">修复 A/B 模块的 bug</span>");
  });

  it("keeps session mention labels verbatim through the composer chip", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerDirectiveChip, {
        directiveId: "/Users/tanliuyi/.pi/agent/sessions/--general--/a.jsonl",
        directiveType: "file",
        label: "修复 A/B 模块的 bug",
      }),
    );

    expect(markup).toContain('aria-label="修复 A/B 模块的 bug"');
    expect(markup).toContain(">修复 A/B 模块的 bug</span>");
  });

  it("keeps the composer directive identity while rendering the final path segment", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerDirectiveChip, {
        directiveId: "packages/desktop/src/renderer/src/components/assistant-ui/directive-text.tsx",
        directiveType: "file",
        label: "packages/desktop/src/renderer/src/components/assistant-ui/directive-text.tsx",
      }),
    );

    expect(markup).toContain(
      'data-directive-id="packages/desktop/src/renderer/src/components/assistant-ui/directive-text.tsx"',
    );
    expect(markup).toContain('class="inline-flex items-baseline px-1"');
    expect(markup).toContain('class="lucide lucide-file');
    expect(markup).toContain('aria-label="directive-text.tsx"');
    expect(markup).toContain(">directive-text.tsx</span>");
  });

  it("renders skill directive chips with the skill icon", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerDirectiveChip, {
        directiveId: "skill:frontend",
        directiveType: "skill",
        label: "frontend",
      }),
    );

    expect(markup).toContain('data-directive-type="skill"');
    expect(markup).toContain('data-directive-id="skill:frontend"');
    expect(markup).toContain(">frontend</span>");
  });

  it("leaves non-file directive labels unchanged", () => {
    expect(directiveDisplayLabel("command", "packages/desktop/src/renderer/src/components/assistant-ui")).toBe(
      "packages/desktop/src/renderer/src/components/assistant-ui",
    );
  });

  it("takes the final path segment only for file path labels, not session titles", () => {
    expect(
      directiveDisplayLabel(
        "file",
        "packages/desktop/src/renderer/src/components/assistant-ui/directive-text.tsx",
        "directive-text",
      ),
    ).toBe("directive-text.tsx");
    expect(directiveDisplayLabel("file", "修复 A/B 模块的 bug", "/sessions/a.jsonl")).toBe("修复 A/B 模块的 bug");
    expect(directiveDisplayLabel("file", "修复模块的 bug", "/sessions/a.jsonl")).toBe("修复模块的 bug");
  });

  it("does not render a file icon for other directive types", () => {
    const markup = renderToStaticMarkup(createElement(RenderDirectiveText, { text: "Run :command[test]{name=test}." }));

    expect(markup).toContain('data-directive-type="command"');
    expect(markup).not.toContain('class="lucide lucide-file');
  });

  it("renders legacy Pi composer @path file references", () => {
    const markup = renderToStaticMarkup(
      createElement(RenderDirectiveText, { text: "Inspect @src/main.ts before editing." }),
    );

    expect(markup).toContain('data-directive-type="file"');
    expect(markup).toContain('data-directive-id="src/main.ts"');
    expect(markup).toContain("src/main.ts");
    expect(markup).not.toContain("@src/main.ts");
  });
});
