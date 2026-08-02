import { useAui } from "@assistant-ui/react";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";
import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PiQuote } from "../../../../shared/contracts.ts";
import { appendComposerQuote } from "../../runtime/composer-quotes.ts";

interface SelectionToolbarProps {
  rootRef: RefObject<HTMLElement | null>;
}

interface SelectionInfo extends PiQuote {
  rect: DOMRect;
}

/** Quotes text selected inside this thread only; each session owns its toolbar runtime. */
export function SelectionToolbar({ rootRef }: SelectionToolbarProps) {
  const aui = useAui();
  const [info, setInfo] = useState<SelectionInfo | null>(null);

  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setInfo(readSelectionInfo(window.getSelection(), rootRef.current));
      });
    };
    const clearIfCollapsed = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setInfo(null);
    };
    const clear = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      setInfo(null);
    };

    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", clearIfCollapsed);
    document.addEventListener("scroll", clear, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", clearIfCollapsed);
      document.removeEventListener("scroll", clear, true);
    };
  }, [rootRef]);

  if (!info) return null;

  return createPortal(
    <div
      className="flex items-center rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{
        position: "fixed",
        top: `${info.rect.top - 8}px`,
        left: `${info.rect.left + info.rect.width / 2}px`,
        transform: "translate(-50%, -100%)",
        zIndex: 50,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="flex h-7 items-center gap-1.5 rounded-xl px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="引用选中文本"
        onClick={() => {
          appendComposerQuote(aui.thread().composer(), { text: info.text, messageId: info.messageId });
          window.getSelection()?.removeAllRanges();
          setInfo(null);
        }}
      >
        <Quote aria-hidden="true" className="size-3.5" />
        引用
      </button>
    </div>,
    document.body,
  );
}

export function readSelectionInfo(selection: Selection | null, root: HTMLElement | null): SelectionInfo | null {
  if (!selection || selection.isCollapsed || !root) return null;
  const text = selection.toString().trim();
  if (!text || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  // 仅 AI 回复文本与用户 prompt 允许引用：锚点与焦点都必须在标记了 data-aui-quote-selectable 的区域里。
  if (!isQuoteSelectable(selection.anchorNode) || !isQuoteSelectable(selection.focusNode)) return null;

  const anchorId = findMessageId(selection.anchorNode, root);
  const focusId = findMessageId(selection.focusNode, root);
  if (!anchorId || anchorId !== focusId) return null;

  const range = selection.getRangeAt(0);
  return { text, messageId: anchorId, rect: range.getBoundingClientRect() };
}

function isQuoteSelectable(node: Node | null): boolean {
  const element = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return Boolean(element?.closest("[data-aui-quote-selectable]"));
}

function findMessageId(node: Node | null, root: HTMLElement): string | null {
  let element = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  while (element && root.contains(element)) {
    const id = element.getAttribute("data-message-id");
    if (id) return id;
    element = element.parentElement;
  }
  return null;
}
