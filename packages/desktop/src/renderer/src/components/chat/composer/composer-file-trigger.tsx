import { ComposerPrimitive, type Unstable_TriggerItem, unstable_useLiveCompletionAdapter } from "@assistant-ui/react";
import File from "lucide-react/dist/esm/icons/file.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import { useCallback, useRef } from "react";
import { ComposerFileTriggerState } from "./composer-file-trigger-state.tsx";
import { fileSuggestions, searchSessions, sessionMentionLabel, sessionPreview } from "./composer-suggestion-model.ts";
import { ComposerSuggestionScrollSync } from "./composer-suggestion-scroll-sync.tsx";

const SESSION_MENTION_SOURCE = "session";

interface ComposerFileTriggerProps {
  projectId: string;
  onOpenChange(open: boolean): void;
}

/** Official assistant-ui @ trigger backed by the project file index and session metadata. */
export function ComposerFileTrigger({ projectId, onOpenChange }: ComposerFileTriggerProps) {
  const scrollContainer = useRef<HTMLDivElement>(null);
  const fetchSuggestions = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      const [files, sessions] = await Promise.all([
        window.desktop.files.list(projectId, "", query, "composer-file-trigger"),
        window.desktop.sessions.listWithPaths(projectId),
      ]);
      const fileItems = fileSuggestions(files.slice(0, 10)).map((file) => ({
        id: file.id,
        type: file.type,
        label: file.label,
        description: file.detail,
      }));
      const sessionItems = searchSessions(sessions, query)
        .slice(0, 10)
        .map((session) => ({
          id: session.path,
          type: "file",
          label: sessionMentionLabel(session.title),
          description: sessionPreview(session),
          metadata: { source: SESSION_MENTION_SOURCE, threadId: session.id },
        }));
      return [...fileItems, ...sessionItems];
    },
    [projectId],
  );
  const { adapter, isLoading } = unstable_useLiveCompletionAdapter({
    fetcher: fetchSuggestions,
    debounceMs: 200,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      isLoading={isLoading}
      className="composer-suggestions"
      aria-label="文件与会话建议"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive />
      <ComposerFileTriggerState onOpenChange={onOpenChange} />
      <ComposerSuggestionScrollSync container={scrollContainer} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems ref={scrollContainer} className="composer-suggestions-scroll">
        {(items) => {
          if (items.length === 0) {
            return isLoading ? (
              <div className="composer-suggestions-loading" role="status">
                <LoaderCircle size={16} aria-hidden="true" />
                <span>正在加载文件…</span>
              </div>
            ) : (
              <div className="composer-suggestions-empty">无匹配文件或会话</div>
            );
          }
          const fileItems = items.filter((item) => item.metadata?.source !== SESSION_MENTION_SOURCE);
          const sessionItems = items.filter((item) => item.metadata?.source === SESSION_MENTION_SOURCE);
          return (
            <div className="composer-file-groups">
              {fileItems.length > 0 ? (
                <div className="composer-file-group" role="group" aria-label="文件">
                  <div className="composer-file-group-label" aria-hidden="true">
                    文件
                  </div>
                  {fileItems.map((item) => (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id}
                      item={item}
                      className="composer-file-item"
                    >
                      {item.type === "directory" ? (
                        <Folder className="composer-file-item-icon" size={17} />
                      ) : (
                        <File className="composer-file-item-icon" size={17} />
                      )}
                      <strong>{item.label}</strong>
                      {item.description ? <span>{item.description}</span> : <span />}
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  ))}
                </div>
              ) : null}
              {sessionItems.length > 0 ? (
                <div className="composer-file-group" role="group" aria-label="会话">
                  <div className="composer-file-group-label" aria-hidden="true">
                    会话
                  </div>
                  {sessionItems.map((item) => (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id}
                      item={item}
                      className="composer-file-item composer-session-item"
                    >
                      <MessageSquare className="composer-file-item-icon composer-session-item-icon" size={17} />
                      <strong>{item.label}</strong>
                      {item.description ? <span>{item.description}</span> : <span />}
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  ))}
                </div>
              ) : null}
            </div>
          );
        }}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
