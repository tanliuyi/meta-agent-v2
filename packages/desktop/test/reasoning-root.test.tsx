import React, { type ReactNode, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
import { ReasoningDisclosureStateProvider } from "../src/renderer/src/components/assistant-ui/reasoning/reasoning-disclosure-state.tsx";
import { ReasoningRoot } from "../src/renderer/src/components/assistant-ui/reasoning/reasoning-root.tsx";
import { createSessionRecordStores } from "../src/renderer/src/runtime/pi-session-store.ts";

function PreviewState() {
  const isPreview = useContext(ReasoningPreviewContext);
  return <span data-preview={isPreview} />;
}

describe("ReasoningRoot", () => {
  it("用户手动展开后，运行中的内容仍启用自动追底", () => {
    const disclosure = createSessionRecordStores().disclosure;
    disclosure.set("reasoning", true);
    const markup = renderToStaticMarkup(
      <ReasoningDisclosureStateProvider store={disclosure}>
        <ReasoningRoot autoExpand={false} streaming stateKey="reasoning">
          <PreviewState />
        </ReasoningRoot>
      </ReasoningDisclosureStateProvider>,
    );

    expect(markup).toContain('data-open="true"');
    expect(markup).toContain('data-preview="true"');
  });

  it("虚拟行重新挂载时从会话状态恢复展开选择", () => {
    const disclosure = createSessionRecordStores().disclosure;
    disclosure.set("message:chain:0", true);

    const markup = renderToStaticMarkup(
      <ReasoningDisclosureStateProvider store={disclosure}>
        <ReasoningRoot stateKey="message:chain:0">content</ReasoningRoot>
      </ReasoningDisclosureStateProvider>,
    );

    expect(markup).toContain('data-open="true"');
  });
});
