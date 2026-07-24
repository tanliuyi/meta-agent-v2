import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DirectiveText } from "../src/renderer/src/components/assistant-ui/directive-text.tsx";

const RenderDirectiveText = DirectiveText as unknown as FC<{ text: string }>;

describe("DirectiveText", () => {
  it("leaves plain text unchanged", () => {
    expect(renderToStaticMarkup(createElement(RenderDirectiveText, { text: "Inspect the current workspace." }))).toBe(
      "Inspect the current workspace.",
    );
  });

  it("renders default directives as labeled chips", () => {
    const markup = renderToStaticMarkup(
      createElement(RenderDirectiveText, { text: "Inspect :file[README.md]{name=readme} before editing." }),
    );

    expect(markup).toContain('data-slot="directive-text-chip"');
    expect(markup).toContain('data-directive-type="file"');
    expect(markup).toContain('data-directive-id="readme"');
    expect(markup).toContain("README.md");
    expect(markup).not.toContain(":file[README.md]");
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
