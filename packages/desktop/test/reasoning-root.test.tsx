import React, { type ReactNode, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: vi.fn(() => [true, vi.fn()]),
  };
});

vi.mock("@assistant-ui/react", () => ({
  useScrollLock: () => vi.fn(),
}));

vi.mock("@renderer/shared/lib/cn", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

vi.mock("@renderer/shared/ui/collapsible", () => ({
  Collapsible: ({ open, children }: { open?: boolean; children: ReactNode }) => <div data-open={open}>{children}</div>,
}));

import { ReasoningPreviewContext } from "../src/renderer/src/components/assistant-ui/reasoning/reasoning-context.ts";
import { ReasoningRoot } from "../src/renderer/src/components/assistant-ui/reasoning/reasoning-root.tsx";

function PreviewState() {
  const isPreview = useContext(ReasoningPreviewContext);
  return <span data-preview={isPreview} />;
}

describe("ReasoningRoot", () => {
  it("用户手动展开后，运行中的内容仍启用自动追底", () => {
    const markup = renderToStaticMarkup(
      <ReasoningRoot autoExpand={false} streaming>
        <PreviewState />
      </ReasoningRoot>,
    );

    expect(markup).toContain('data-open="true"');
    expect(markup).toContain('data-preview="true"');
  });
});
