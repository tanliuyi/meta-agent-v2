import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { DirectiveText } from "@renderer/components/assistant-ui/directive-text";
import { Button } from "@renderer/shared/ui/button";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";
import { useLayoutEffect, useRef, useState } from "react";
import { getMessageQuotes } from "../../../runtime/composer-quotes.ts";
import { cn } from "../../../shared/lib/cn.ts";

const COLLAPSED_USER_MESSAGE_HEIGHT = 160;
const USER_MESSAGE_PARTS = { Text: DirectiveText };

export function UserMessageContent() {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const custom = useAuiState((state) => state.message.metadata.custom);
  const quotes = getMessageQuotes(custom);
  const hasContent = useAuiState((state) =>
    state.message.parts.some((part) => part.type !== "text" || part.text.trim().length > 0),
  );

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setIsLong(element.scrollHeight > COLLAPSED_USER_MESSAGE_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!hasContent) return null;

  return (
    <div className="aui-user-message-content text-foreground rounded-xl px-4 py-2 wrap-break-word text-sm">
      <div ref={contentRef} className={cn(!isExpanded && "max-h-40 overflow-hidden")}>
        {quotes.map((quote, index) => (
          <div key={`${quote.messageId}:${index}`} className="mb-2 flex min-w-0 items-start gap-1.5">
            <Quote aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
            <p className="line-clamp-2 min-w-0 wrap-break-word text-sm italic text-muted-foreground/80">{quote.text}</p>
          </div>
        ))}
        <div data-aui-quote-selectable="" className="contents">
          <MessagePrimitive.Parts components={USER_MESSAGE_PARTS} />
        </div>
      </div>
      {isLong ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ms-auto mt-1 flex h-6 gap-1 rounded-xl px-2 text-xs"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? <ChevronUp /> : <ChevronDown />}
          {isExpanded ? "收起" : "展开"}
        </Button>
      ) : null}
    </div>
  );
}
