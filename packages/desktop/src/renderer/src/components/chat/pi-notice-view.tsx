import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@renderer/components/assistant-ui/reasoning";
import { StreamdownMarkdown } from "@renderer/components/assistant-ui/streamdown-text";
import type { PiNoticeContent, PiNoticeMessage } from "../../../../shared/contracts.ts";

export function PiNoticeView({ data }: { data: unknown }) {
  if (!isPiNotice(data)) return null;

  if (data.noticeType === "compaction") {
    return (
      <section className="pi-compaction-notice" data-notice-type="compaction">
        <header>上下文已压缩</header>
      </section>
    );
  }

  return (
    <ReasoningRoot className="pi-notice" variant="ghost" data-notice-type={data.noticeType}>
      <ReasoningTrigger className="max-w-full" label={noticeTitle(data)} />
      <ReasoningContent fade={false}>
        <ReasoningText>
          <NoticeContent id={data.id} title={data.title} content={data.content} />
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function NoticeContent({ id, title, content }: { id: string; title: string; content: PiNoticeContent }) {
  if (content.type === "text") return <StreamdownMarkdown>{content.text}</StreamdownMarkdown>;

  if (content.type === "command") {
    return (
      <div className="pi-notice-command">
        <code>{content.command}</code>
        {content.output ? <pre>{content.output}</pre> : null}
        <small>
          {content.cancelled ? "已取消" : content.exitCode === undefined ? "已完成" : `退出码 ${content.exitCode}`}
        </small>
      </div>
    );
  }

  return (
    <div className="pi-notice-custom">
      {content.content.map((part, index) =>
        part.type === "text" ? (
          <StreamdownMarkdown key={`${id}:text:${index}`}>{part.text}</StreamdownMarkdown>
        ) : (
          <img
            key={`${id}:image:${index}`}
            src={`data:${part.mimeType};base64,${part.data}`}
            alt={`${title} ${index + 1}`}
          />
        ),
      )}
    </div>
  );
}

function noticeTitle(notice: PiNoticeMessage): string {
  if (notice.noticeType === "bash") return "终端命令";
  if (notice.noticeType === "branch-summary") return "分支摘要";
  return notice.title;
}

function isPiNotice(value: unknown): value is PiNoticeMessage {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "notice" ||
    !("noticeType" in value) ||
    typeof value.noticeType !== "string" ||
    !("content" in value)
  ) {
    return false;
  }

  return isPiNoticeContent(value.content);
}

function isPiNoticeContent(value: unknown): value is PiNoticeContent {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;

  if (value.type === "text") return "text" in value && typeof value.text === "string";
  if (value.type === "command") {
    return (
      "command" in value &&
      typeof value.command === "string" &&
      "output" in value &&
      typeof value.output === "string" &&
      "cancelled" in value &&
      typeof value.cancelled === "boolean"
    );
  }
  if (value.type !== "custom" || !("content" in value) || !Array.isArray(value.content)) return false;

  return value.content.every(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      "type" in part &&
      ((part.type === "text" && "text" in part && typeof part.text === "string") ||
        (part.type === "image" &&
          "data" in part &&
          typeof part.data === "string" &&
          "mimeType" in part &&
          typeof part.mimeType === "string")),
  );
}
