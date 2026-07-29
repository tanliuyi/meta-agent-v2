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

  it("leaves non-file directive labels unchanged", () => {
    expect(directiveDisplayLabel("command", "packages/desktop/src/renderer/src/components/assistant-ui")).toBe(
      "packages/desktop/src/renderer/src/components/assistant-ui",
    );
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
