import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";

interface ComposerEditorSyncProps {
  projectId: string;
  threadId: string;
  editorRevision: number;
  editorText: string | undefined;
  onError(error: unknown): void;
}

/**
 * 隔离 HostUi editor 与 assistant-ui Composer 的逐键同步。
 * 该无 DOM 组件独占 text 订阅，输入变化不得触发 Composer 容器或历史消息重渲染。
 */
export function ComposerEditorSync({
  projectId,
  threadId,
  editorRevision,
  editorText,
  onError,
}: ComposerEditorSyncProps) {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const appliedEditorRevision = useRef<{ target: string; revision: number } | null>(null);
  const syncedEditor = useRef<{ target: string; text: string } | null>(null);
  const activeTarget = useRef("");
  const target = `${projectId}:${threadId}`;
  activeTarget.current = target;

  useEffect(() => {
    const applied = appliedEditorRevision.current;
    if (applied?.target === target && applied.revision === editorRevision) return;
    appliedEditorRevision.current = { target, revision: editorRevision };
    if (editorText === undefined || aui.composer().getState().text === editorText) return;
    syncedEditor.current = { target, text: editorText };
    aui.composer().setText(editorText);
  }, [aui, editorRevision, editorText, target]);

  useEffect(() => {
    const synced = syncedEditor.current;
    if (synced?.target !== target) {
      syncedEditor.current = { target, text: composerText };
      return;
    }
    if (synced.text === composerText) return;
    syncedEditor.current = { target, text: composerText };
    void window.desktop.sessions.setEditorText(projectId, threadId, composerText).catch((error: unknown) => {
      if (activeTarget.current === target) onError(error);
    });
  }, [composerText, onError, projectId, target, threadId]);

  return null;
}
