import { ReasoningContent } from "@renderer/components/assistant-ui/reasoning/reasoning-content";
import { ReasoningRoot } from "@renderer/components/assistant-ui/reasoning/reasoning-root";
import { ReasoningText } from "@renderer/components/assistant-ui/reasoning/reasoning-text";
import { ReasoningTrigger } from "@renderer/components/assistant-ui/reasoning/reasoning-trigger";
import { getHostNotificationSemantics } from "./host-notification-model.ts";
import { isPiNotice, noticeTitle } from "./pi-notice.ts";
import { PiNoticeContentView } from "./pi-notice-content-view.tsx";

export function PiNoticeView({ data }: { data: unknown }) {
  if (!isPiNotice(data)) return null;

  if (data.noticeType === "compaction") {
    return (
      <section className="pi-compaction-notice" data-notice-type="compaction">
        <header>上下文已压缩</header>
      </section>
    );
  }

  if (data.noticeType === "notification" && data.content.type === "text") {
    const semantics = getHostNotificationSemantics(data.notificationType);
    const label = semantics.tone === "warning" ? "警告：" : semantics.tone === "error" ? "错误：" : undefined;
    return (
      <div
        className="pi-notification"
        data-notice-type="notification"
        data-tone={semantics.tone}
        role={semantics.role}
        aria-live={semantics.live}
        aria-atomic="true"
      >
        {label ? <strong>{label}</strong> : null}
        <span>{data.content.text}</span>
      </div>
    );
  }

  return (
    <ReasoningRoot className="pi-notice" variant="ghost" data-notice-type={data.noticeType}>
      <ReasoningTrigger className="max-w-full" label={noticeTitle(data)} />
      <ReasoningContent fade={false}>
        <ReasoningText>
          <PiNoticeContentView id={data.id} title={data.title} content={data.content} />
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
