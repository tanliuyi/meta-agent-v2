import { StreamdownMarkdown } from "@renderer/components/assistant-ui/streamdown/streamdown-markdown";
import type { PiNoticeContent } from "../../../../shared/contracts.ts";

export function PiNoticeContentView({ id, title, content }: { id: string; title: string; content: PiNoticeContent }) {
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
