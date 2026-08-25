import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import { useEffect, useRef, useState } from "react";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionIdentity } from "../session-context.tsx";

/** 当前主会话的只读基本信息。 */
export function SessionInfo({ open }: { open: boolean }) {
  const identity = useSessionIdentity();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copySessionId = async () => {
    await navigator.clipboard.writeText(identity.threadId);
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <aside
      id="session-info-panel"
      className="session-info-panel"
      data-open={open}
      aria-hidden={!open}
      aria-label="会话信息"
    >
      <dl className="session-info-list session-info-list-technical">
        <div className="session-info-id-row">
          <dt>会话 ID</dt>
          <dd>
            <span className="session-info-id-value" title={identity.threadId}>
              {identity.threadId}
            </span>
            <TooltipIconButton
              className="session-info-copy"
              tooltip={copied ? "已复制" : "复制会话 ID"}
              side="top"
              onClick={() => void copySessionId().catch(() => undefined)}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </TooltipIconButton>
          </dd>
        </div>
      </dl>
    </aside>
  );
}
