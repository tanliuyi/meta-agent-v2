import { useAui, useAuiState } from "@assistant-ui/react";
import Globe2 from "lucide-react/dist/esm/icons/globe-2.mjs";
import MessageSquareMore from "lucide-react/dist/esm/icons/message-square-more.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { getComposerQuotes, removeComposerQuote } from "../../../runtime/composer-quotes.ts";
import { Popover } from "../../../shared/ui/popover.tsx";
import { PopoverContent } from "../../../shared/ui/popover-content.tsx";
import { PopoverTrigger } from "../../../shared/ui/popover-trigger.tsx";
import { useSessionModalContext } from "../../session-modal-context.ts";

type PreviewTag = { kind: "browser-annotation" | "text"; label: string };

function getPreviewTags(tags: readonly string[]): PreviewTag[] {
  const previewTags: PreviewTag[] = [];
  let elementTag: PreviewTag | undefined;
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (tag === "浏览器标注") {
      if (!previewTags.some((item) => item.kind === "browser-annotation")) {
        previewTags.push({ kind: "browser-annotation", label: tag });
      }
      continue;
    }
    if (tag.startsWith("元素 ")) {
      const label = tag.slice(3).trim();
      if (!label) continue;
      elementTag = { kind: "text", label };
      previewTags.push(elementTag);
      continue;
    }
    if (tag.startsWith("选择器 ")) {
      const label = tag.slice(4).trim();
      if (!label) continue;
      if (elementTag) elementTag.label = `${elementTag.label} ${label}`;
      else previewTags.push({ kind: "text", label });
      continue;
    }
    if (tag.startsWith("链接 ")) {
      const label = tag.slice(3).trim();
      if (label) previewTags.push({ kind: "text", label });
      continue;
    }
    previewTags.push({ kind: "text", label: tag });
  }
  return previewTags;
}

/** Shows a compact quote count and expands quote metadata and text on hover. */
export function ComposerQuotes() {
  const aui = useAui();
  const inModal = useSessionModalContext();
  const quote = useAuiState((state) => state.composer.quote);
  const quotes = getComposerQuotes(quote);
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current === null) return;
    clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = null;
  }, []);
  const showPreview = useCallback(() => {
    clearCloseTimeout();
    setOpen(true);
  }, [clearCloseTimeout]);
  const scheduleClose = useCallback(() => {
    clearCloseTimeout();
    closeTimeoutRef.current = setTimeout(() => {
      closeTimeoutRef.current = null;
      setOpen(false);
    }, 160);
  }, [clearCloseTimeout]);

  useEffect(() => clearCloseTimeout, [clearCloseTimeout]);

  if (quotes.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="composer-quotes">
        <PopoverTrigger asChild>
          <div
            className="composer-quotes-anchor"
            aria-label={`${quotes.length} 条引用`}
            onBlur={scheduleClose}
            tabIndex={0}
          >
            <div className="composer-quotes-trigger" onPointerEnter={showPreview} onPointerLeave={scheduleClose}>
              <MessageSquareMore aria-hidden="true" className="composer-quotes-icon size-3!" />
              <span className="text-xs color-muted-foreground">{quotes.length} 条引用</span>
              <div className="composer-quotes-dismiss">
                <button type="button" aria-label="移除全部引用" onClick={() => aui.composer().setQuote(undefined)}>
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </PopoverTrigger>
        <PopoverContent
          aria-label="引用预览"
          align="start"
          className={`composer-quotes-preview w-[420px] max-w-[calc(100vw-var(--space-9)-var(--space-9))] max-h-(--layout-dialog-max-height) p-(--space-4)${inModal ? " z-(--stack-menu)" : ""}`}
          collisionPadding={4}
          onBlur={scheduleClose}
          onFocus={showPreview}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={showPreview}
          onPointerLeave={scheduleClose}
          side="top"
          sideOffset={4}
        >
          <ol className="composer-quotes-preview-list">
            {quotes.map((item, index) => (
              <li key={`${item.messageId}:${index}`} className="composer-quotes-preview-item">
                <span className="composer-quotes-preview-index">{index + 1}.</span>
                <div className="composer-quotes-preview-copy">
                  {item.tags && item.tags.length > 0 ? (
                    <div className="composer-quotes-preview-tags" aria-label="引用标签">
                      {getPreviewTags(item.tags).map((tag, tagIndex) =>
                        tag.kind === "browser-annotation" ? (
                          <span
                            key={`${tagIndex}:${tag.label}`}
                            className="composer-quotes-preview-tag"
                            data-tag-kind="browser-annotation"
                            aria-label={tag.label}
                            title={tag.label}
                          >
                            <Globe2 aria-hidden="true" className="composer-quotes-preview-tag-icon" />
                          </span>
                        ) : (
                          <span
                            key={`${tagIndex}:${tag.label}`}
                            className="composer-quotes-preview-tag"
                            title={tag.label}
                          >
                            {tag.label}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                  <p>{item.text}</p>
                </div>
                <button
                  type="button"
                  aria-label={`移除第 ${index + 1} 条引用`}
                  className="composer-quotes-preview-remove"
                  onClick={() => removeComposerQuote(aui.thread().composer(), index)}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </li>
            ))}
          </ol>
        </PopoverContent>
      </div>
    </Popover>
  );
}
