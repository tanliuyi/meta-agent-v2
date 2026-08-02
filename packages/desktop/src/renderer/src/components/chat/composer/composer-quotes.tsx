import { useAui, useAuiState } from "@assistant-ui/react";
import MessageSquareMore from "lucide-react/dist/esm/icons/message-square-more.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { getComposerQuotes, removeComposerQuote } from "../../../runtime/composer-quotes.ts";

/** Shows a compact quote count and expands the selected text preview on hover. */
export function ComposerQuotes() {
  const aui = useAui();
  const quote = useAuiState((state) => state.composer.quote);
  const quotes = getComposerQuotes(quote);
  if (quotes.length === 0) return null;

  return (
    <div className="composer-quotes" aria-label={`${quotes.length} 条注释`}>
      <div className="composer-quotes-preview" aria-label="引用预览">
        <ol className="composer-quotes-preview-list">
          {quotes.map((item, index) => (
            <li key={`${item.messageId}:${index}`} className="composer-quotes-preview-item">
              <span className="composer-quotes-preview-index">{index + 1}.</span>
              <div className="composer-quotes-preview-copy">
                <span className="composer-quotes-preview-label">所选文本：</span>
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
      </div>
      <div className="composer-quotes-trigger">
        <MessageSquareMore aria-hidden="true" className="composer-quotes-icon" />
        <span>{quotes.length} 条注释</span>
        <button
          type="button"
          aria-label="移除全部引用"
          className="composer-quotes-dismiss"
          onClick={() => aui.composer().setQuote(undefined)}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
