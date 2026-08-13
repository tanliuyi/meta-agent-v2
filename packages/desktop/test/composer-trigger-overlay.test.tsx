import { readFileSync } from "node:fs";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionModalContext } from "../src/renderer/src/components/session-modal-context.ts";

vi.mock("@assistant-ui/react", () => {
  const TriggerPopover = ({ className, children }: { className?: string; children?: ReactNode }) => (
    <div className={className}>{children}</div>
  );
  (TriggerPopover as { Action?: () => null }).Action = () => null;
  (TriggerPopover as { Directive?: () => null }).Directive = () => null;
  return {
    ComposerPrimitive: {
      Unstable_TriggerPopover: TriggerPopover,
      Unstable_TriggerPopoverItems: ({ children }: { children?: (items: readonly unknown[]) => ReactNode }) => (
        <>{children?.([])}</>
      ),
      Unstable_TriggerPopoverItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
    },
    unstable_useLiveCompletionAdapter: () => ({
      adapter: { categories: () => [], categoryItems: () => [], search: () => [] },
      isLoading: false,
    }),
  };
});
vi.mock("../src/renderer/src/components/chat/composer/composer-suggestion-scroll-sync.tsx", () => ({
  ComposerSuggestionScrollSync: () => null,
}));
vi.mock("../src/renderer/src/components/chat/composer/composer-trigger-state.tsx", () => ({
  ComposerTriggerState: () => null,
}));
vi.mock("../src/renderer/src/components/chat/composer/composer-file-trigger-state.tsx", () => ({
  ComposerFileTriggerState: () => null,
}));

import { ComposerCommandTrigger } from "../src/renderer/src/components/chat/composer/composer-command-trigger.tsx";
import { ComposerFileTrigger } from "../src/renderer/src/components/chat/composer/composer-file-trigger.tsx";

const OVERLAY_CLASS = "session-modal-composer-overlay";

describe("composer trigger overlay stacking", () => {
  it("普通聊天不提升候选层", () => {
    const command = renderToStaticMarkup(
      <ComposerCommandTrigger commands={[]} onSelect={() => undefined} onOpenChange={() => undefined} />,
    );
    const file = renderToStaticMarkup(<ComposerFileTrigger projectId="project-1" onOpenChange={() => undefined} />);

    expect(command).toContain('class="composer-suggestions"');
    expect(command).not.toContain(OVERLAY_CLASS);
    expect(file).not.toContain(OVERLAY_CLASS);
  });

  it("全屏会话 modal 内为 / 与 @ 候选层提升层级", () => {
    const command = renderToStaticMarkup(
      <SessionModalContext.Provider value>
        <ComposerCommandTrigger commands={[]} onSelect={() => undefined} onOpenChange={() => undefined} />
      </SessionModalContext.Provider>,
    );
    const file = renderToStaticMarkup(
      <SessionModalContext.Provider value>
        <ComposerFileTrigger projectId="project-1" onOpenChange={() => undefined} />
      </SessionModalContext.Provider>,
    );

    expect(command).toContain("composer-suggestions session-modal-composer-overlay");
    expect(file).toContain("composer-suggestions session-modal-composer-overlay");
  });

  it("chat.css 中 scoped 规则把 overlay 提升到 --stack-menu", () => {
    const css = readFileSync(new URL("../src/renderer/src/styles/chat.css", import.meta.url), "utf8");
    const rule = css.match(/\.composer-suggestions\.session-modal-composer-overlay\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("z-index: var(--stack-menu)");
    // 普通 .composer-suggestions 仍保持 suggestions 层级，未全局提升。
    const base = css.match(/\.composer-suggestions\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toContain("z-index: var(--stack-suggestions)");
  });
});
