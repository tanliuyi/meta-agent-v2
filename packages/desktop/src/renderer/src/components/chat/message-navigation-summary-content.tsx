import { type ThreadMessage, useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { DirectiveTextContent } from "../assistant-ui/directive-text-content.tsx";
import { StreamdownMarkdown } from "../assistant-ui/streamdown/streamdown-markdown.tsx";

const MESSAGE_NAVIGATION_SUMMARY_MAX_ITEMS = 2;
const MESSAGE_NAVIGATION_USER_PREVIEW_MAX_CHARS = 240;
const MESSAGE_NAVIGATION_ASSISTANT_PREVIEW_MAX_CHARS = 480;

interface MessageNavigationSummary {
  markdown: boolean;
  text: string;
}

export function MessageNavigationSummaryContent({ messageIds }: { messageIds: readonly string[] }) {
  const messages = useAuiState((state) => state.thread.messages);
  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const summary = messageIds
    .flatMap((messageId) => messageSummary(messagesById.get(messageId)))
    .slice(0, MESSAGE_NAVIGATION_SUMMARY_MAX_ITEMS);

  return (summary.length > 0 ? summary : [{ markdown: false, text: "消息" }]).map((item, summaryIndex) =>
    item.markdown ? (
      <div key={summaryIndex} className="message-navigation-summary-markdown">
        <StreamdownMarkdown>{item.text}</StreamdownMarkdown>
      </div>
    ) : (
      <span key={summaryIndex}>
        <DirectiveTextContent text={item.text} />
      </span>
    ),
  );
}

function messageSummary(message: ThreadMessage | undefined): MessageNavigationSummary[] {
  if (!message) return [];
  const text =
    message.role === "assistant"
      ? assistantFinalResponseText(message)
      : messageText(message.content).replace(/\s+/g, " ");
  if (!text) return [];
  const markdown = message.role === "assistant";
  return [
    {
      markdown,
      text: truncateMessageNavigationPreview(
        text,
        markdown ? MESSAGE_NAVIGATION_ASSISTANT_PREVIEW_MAX_CHARS : MESSAGE_NAVIGATION_USER_PREVIEW_MAX_CHARS,
      ),
    },
  ];
}

function assistantFinalResponseText(message: ThreadMessage): string {
  const lastRunPartIndex = message.content.findLastIndex(
    (part) => part.type === "reasoning" || part.type === "tool-call",
  );
  return messageText(message.content.slice(lastRunPartIndex + 1));
}

function messageText(parts: readonly unknown[]): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  return textParts.join("\n\n").trim();
}

function truncateMessageNavigationPreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}
