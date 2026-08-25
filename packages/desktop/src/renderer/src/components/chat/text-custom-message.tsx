import type { PiNoticeMessage } from "../../../../shared/contracts.ts";
import { TerminalBlock } from "../assistant-ui/terminal-block.tsx";

type TextCustomNotice = PiNoticeMessage & {
  noticeType: "custom";
  content: Extract<PiNoticeMessage["content"], { type: "custom" }>;
};

/** Renders any completed, text-only custom message without interpreting extension-specific semantics. */
export function TextCustomMessage({ notice }: { notice: TextCustomNotice }) {
  const text = notice.content.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return (
    <TerminalBlock
      title={notice.title}
      lines={trimTrailingEmptyLines(text.replace(/\r/g, "").split("\n"))}
      aria-label={`${notice.title}消息内容`}
    />
  );
}

export function isTextCustomMessage(notice: PiNoticeMessage): notice is TextCustomNotice {
  return (
    notice.noticeType === "custom" &&
    notice.content.type === "custom" &&
    notice.content.content.length > 0 &&
    notice.content.content.every((part) => part.type === "text")
  );
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}
