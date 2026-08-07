import { autoUpdate, FloatingPortal, flip, offset, shift, useFloating } from "@floating-ui/react";
import { memo, useMemo } from "react";
import { DirectiveTextContent } from "../assistant-ui/directive-text-content.tsx";
import { StreamdownMarkdown } from "../assistant-ui/streamdown/streamdown-markdown.tsx";
import type { MessageNavigationSummary } from "./message-navigation.tsx";

interface MessageNavigationItemProps {
  index: number;
  active: boolean;
  current: boolean;
  hovered: boolean;
  hoverDistance: number | null;
  summary: readonly MessageNavigationSummary[];
  workspace: HTMLElement | null;
  onSelect(index: number): void;
}

export const MessageNavigationItem = memo(function MessageNavigationItem({
  index,
  active,
  current,
  hovered,
  hoverDistance,
  summary,
  workspace,
  onSelect,
}: MessageNavigationItemProps) {
  const middleware = useMemo(
    () => [
      offset(14),
      flip({ boundary: workspace ?? undefined }),
      shift({ boundary: workspace ?? undefined, padding: 12 }),
    ],
    [workspace],
  );
  const { refs, floatingStyles } = useFloating({
    open: hovered,
    placement: "right",
    middleware,
    whileElementsMounted: autoUpdate,
  });

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className="message-navigation-item"
        data-index={index}
        data-active={active ? "true" : undefined}
        data-hover-distance={hoverDistance ?? undefined}
        aria-current={current ? "location" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(index);
        }}
      />
      {hovered && workspace ? (
        <FloatingPortal root={workspace} preserveTabOrder={false}>
          <div ref={refs.setFloating} className="message-navigation-summary" style={floatingStyles} role="tooltip">
            {summary.map((item, summaryIndex) =>
              item.markdown ? (
                <div key={summaryIndex} className="message-navigation-summary-markdown">
                  <StreamdownMarkdown>{item.text}</StreamdownMarkdown>
                </div>
              ) : (
                <span key={summaryIndex}>
                  <DirectiveTextContent text={item.text} />
                </span>
              ),
            )}
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
});
