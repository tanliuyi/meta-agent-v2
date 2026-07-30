import { StreamdownMarkdown } from "@renderer/components/assistant-ui/streamdown/streamdown-markdown";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { useState } from "react";
import { AcceptanceReportView } from "./acceptance-report-view.tsx";
import type { SubagentNotificationItem } from "./subagent-notification-data.ts";

export function SubagentResultItem({ item }: { item: SubagentNotificationItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(item.report || item.sessionValue || (item.markdown && item.markdown !== item.summary));
  return (
    <Collapsible
      className="builtin-subagent-result"
      data-status={item.status}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <div className="builtin-subagent-result-row">
        <CollapsibleTrigger asChild disabled={!hasDetails}>
          <button className="builtin-subagent-result-trigger" type="button">
            <span className="tool-subagent-status-dot" aria-hidden="true" />
            <strong>{item.agent}</strong>
            <span className="builtin-subagent-status">{item.statusLabel}</span>
            <span className="builtin-subagent-summary">{item.summary}</span>
          </button>
        </CollapsibleTrigger>
        {item.meta.length > 0 ? <span className="builtin-subagent-meta">{item.meta.join(" · ")}</span> : null}
        {hasDetails ? (
          <CollapsibleTrigger
            className="tool-expand-trigger"
            aria-label={`${expanded ? "收起" : "展开"}${item.agent}结果详情`}
          >
            <ChevronRight size={15} className="tool-chevron" aria-hidden="true" />
          </CollapsibleTrigger>
        ) : null}
      </div>
      {hasDetails ? (
        <CollapsibleContent animation="persistent">
          <div className="builtin-subagent-detail-scroll">
            {item.markdown ? (
              <div className="builtin-subagent-markdown">
                <StreamdownMarkdown>{item.markdown}</StreamdownMarkdown>
              </div>
            ) : null}
            {item.report ? <AcceptanceReportView report={item.report} /> : null}
            {item.sessionValue ? (
              <div className="tool-note">
                {sessionLabel(item.sessionLabel)}：
                <span className="builtin-subagent-session-value">{item.sessionValue}</span>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function sessionLabel(label: string | undefined): string {
  if (label === "Session file") return "会话文件";
  if (label === "Session share error") return "会话分享失败";
  return "会话";
}
