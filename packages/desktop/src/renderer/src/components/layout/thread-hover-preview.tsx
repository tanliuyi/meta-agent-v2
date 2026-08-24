import { FloatingPortal } from "@floating-ui/react";
import { type CSSProperties } from "react";
import type { LinkSafetyConfig } from "streamdown";
import type { PiThreadSnapshot } from "../../../../shared/contracts.ts";
import {
  previewFirstLines,
  THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
  THREAD_USER_PREVIEW_MAX_CHARS,
} from "../../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../../runtime/pi-session-store.ts";
import { DirectiveTextContent } from "../assistant-ui/directive-text-content.tsx";
import { StreamdownMarkdown } from "../assistant-ui/streamdown/streamdown-markdown.tsx";

// 侧边栏悬浮预览无会话上下文，链接确认 modal 依赖 SessionScope，故禁用链接安全。
const PREVIEW_LINK_SAFETY: LinkSafetyConfig = { enabled: false };

export interface ThreadHoverPreviewSnapshot {
  loaded: boolean;
  user: string;
  assistant: string;
}

/** 从实时 timeline 派生最近一轮已结束的对话；流式 text delta 不进入预览。 */
export function threadHoverPreview(snapshot: PiThreadSnapshot): ThreadHoverPreviewSnapshot {
  let stableAssistant: PiThreadSnapshot["nodes"][number] | undefined;
  let pairedUser: PiThreadSnapshot["nodes"][number] | undefined;
  for (let index = snapshot.nodes.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes[index];
    if (!node) continue;
    if (!stableAssistant) {
      if (node.kind === "assistant" && node.status.type !== "running") stableAssistant = node;
      continue;
    }
    if (node.kind === "user") {
      pairedUser = node;
      break;
    }
  }
  const nodeText = (node: PiThreadSnapshot["nodes"][number] | undefined) =>
    node && (node.kind === "user" || node.kind === "assistant")
      ? node.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      : "";
  return {
    loaded: snapshot.projectId.length > 0,
    user: pairedUser ? previewFirstLines(nodeText(pairedUser), THREAD_USER_PREVIEW_MAX_CHARS) : "",
    assistant: stableAssistant ? previewFirstLines(nodeText(stableAssistant), THREAD_ASSISTANT_PREVIEW_MAX_CHARS) : "",
  };
}

export function ThreadHoverPreview({
  record,
  fallbackUser,
  fallbackAssistant,
  setFloating,
  floatingStyles,
}: {
  record?: CachedSessionRecord;
  fallbackUser: string;
  fallbackAssistant: string;
  setFloating(node: HTMLElement | null): void;
  floatingStyles: CSSProperties;
}) {
  const snapshot = record?.stores.timeline.getInMemorySnapshot();
  const live = snapshot ? threadHoverPreview(snapshot) : { loaded: false, user: "", assistant: "" };
  const user = live.loaded ? live.user : fallbackUser;
  const assistant = live.loaded ? live.assistant : fallbackAssistant;
  if (!user || !assistant) return null;
  return (
    <FloatingPortal preserveTabOrder={false}>
      <div ref={setFloating} className="message-navigation-summary" style={floatingStyles} role="tooltip">
        <span>
          <DirectiveTextContent text={user} />
        </span>
        <div className="message-navigation-summary-markdown">
          <StreamdownMarkdown linkSafety={PREVIEW_LINK_SAFETY}>{assistant}</StreamdownMarkdown>
        </div>
      </div>
    </FloatingPortal>
  );
}
