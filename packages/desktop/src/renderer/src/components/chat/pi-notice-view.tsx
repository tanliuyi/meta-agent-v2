import { ReasoningContent } from "@renderer/components/assistant-ui/reasoning/reasoning-content";
import { ReasoningRoot } from "@renderer/components/assistant-ui/reasoning/reasoning-root";
import { ReasoningText } from "@renderer/components/assistant-ui/reasoning/reasoning-text";
import { ReasoningTrigger } from "@renderer/components/assistant-ui/reasoning/reasoning-trigger";
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
