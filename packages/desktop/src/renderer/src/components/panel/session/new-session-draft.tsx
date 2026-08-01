import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect } from "react";
import { useStore } from "zustand";
import type { ThinkingLevel } from "../../../../../shared/contracts.ts";
import { toPiImageInputs } from "../../../runtime/image-attachments.ts";
import { sessionRecordKey } from "../../../runtime/pi-session-store.ts";
import { useDesktopActions } from "../../../state/desktop-context.tsx";
import { selectProjects } from "../../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../../state/desktop-store-context.tsx";
import {
  isStaleExtensionSetError,
  materializeDraftSession,
  selectDraftModel,
  selectDraftThinkingLevel,
} from "../../../state/draft-creation.ts";
import { useSessionCache } from "../../../state/session-cache-context.tsx";
import { useSessionDraft } from "../../../state/session-draft-context.tsx";
import { workbenchPanelTabKey } from "../../../state/workbench-tab-context.tsx";
import { DraftComposerThread } from "../../chat/draft-composer-thread.tsx";
import { useSessionScope, useSessionWorkbenchTabs } from "../../session-context.tsx";
import { NEW_SESSION_PANEL_KIND } from "../builtin-panel-tabs.tsx";

/**
 * workbench-panel 中的新会话草稿：项目固定为当前主 session 所在项目，
 * 提交后创建主 session 的子会话，并作为侧边栏 tab 打开（不导航主工作区）。
 * 草稿状态按主 session 隔离（见 SessionDraftProvider），切换主 session 不串台。
 */
export function NewSessionDraft() {
  const { record } = useSessionScope();
  const actions = useDesktopActions();
  const sessionCache = useSessionCache();
  const desktopStore = useDesktopStore();
  const workbenchTabs = useSessionWorkbenchTabs();
  const binding = useSessionDraft(record.key);
  const draft = binding?.draft ?? null;
  const runtime = binding?.runtime ?? null;
  const project =
    useStore(desktopStore, selectProjects).find((entry) => entry.id === draft?.parent.projectId && entry.available) ??
    null;

  // 加载主 session 所在项目的草稿配置；主 session 变化（换 record）时重新加载。
  useEffect(() => {
    if (!draft) return;
    const projectId = draft.parent.projectId;
    let active = true;
    draft.setConfig(null);
    draft.setLoadError(null);
    draft.setPhase("editing");
    void window.desktop.sessions
      .getDraftConfig(projectId)
      .then((next) => {
        if (!active) return;
        draft.setConfig(next);
        draft.setLoadError(
          next.extensions.diagnostics.length > 0
            ? next.extensions.diagnostics
                .map((diagnostic) => `${diagnostic.extensionId}: ${diagnostic.message}`)
                .join("\n")
            : null,
        );
      })
      .catch((reason: unknown) => {
        if (active) draft.setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [draft]);

  if (!draft || !runtime) {
    return <div className="panel-content sidebar-session-loading">正在同步草稿…</div>;
  }

  const selectModel = (provider: string, modelId: string): void => {
    draft.setConfig(selectDraftModel(draft.config, provider, modelId));
  };

  const selectThinking = (thinkingLevel: ThinkingLevel): void => {
    draft.setConfig(selectDraftThinkingLevel(draft.config, thinkingLevel));
  };

  const submit = async (): Promise<void> => {
    if (draft.submitInFlight) return;
    if (!draft.config?.model || draft.config.readiness.state !== "ready") return;
    const composer = runtime.thread.composer;
    const state = composer.getState();
    if (state.isEmpty) return;
    draft.setSubmitInFlight(true);
    sessionCache.setDraftMaterializing(true);
    draft.setPhase("materializing");
    try {
      const images = await toPiImageInputs(state.attachments);
      const materialized = await materializeDraftSession(
        {
          projectId: draft.parent.projectId,
          parentThreadId: draft.parent.threadId,
          model: { provider: draft.config.model.provider, id: draft.config.model.id },
          thinkingLevel: draft.config.thinkingLevel,
          extensionSetGeneration: draft.config.extensions.extensionSetGeneration,
          text: state.text,
          images,
        },
        {
          requestIds: draft.createRequestIds,
          sessions: window.desktop.sessions,
          cache: sessionCache,
          onMaterialized() {
            // 子会话的父级关系由 metadata 索引从 session header 推导，主动刷新目录。
            actions.refreshProjectThreads(draft.parent.projectId);
          },
        },
      );
      const target = materialized.target;
      // 作为侧边栏 tab 打开子会话，主工作区保持在主 session；草稿 tab 随之关闭。
      workbenchTabs.openSessionTab({
        kind: "session",
        key: sessionRecordKey(target.projectId, target.threadId),
        projectId: target.projectId,
        threadId: target.threadId,
        displayName: state.text.trim().slice(0, 48) || "新会话",
      });
      workbenchTabs.closeTab(workbenchPanelTabKey(NEW_SESSION_PANEL_KIND));
      await composer.reset();
      draft.clear();
    } catch (reason) {
      draft.setPhase("editing");
      if (isStaleExtensionSetError(reason)) {
        draft.createRequestIds.delete(draft.parent.projectId);
        draft.setConfig(null);
      }
      throw reason;
    } finally {
      draft.setSubmitInFlight(false);
      sessionCache.setDraftMaterializing(false);
    }
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="panel-content sidebar-new-session-draft">
        <DraftComposerThread
          projects={project ? [project] : []}
          project={project}
          config={draft.config}
          configLoading={draft.config === null}
          phase={draft.phase === "materializing" ? "materializing" : "editing"}
          fixedProject
          compact
          onProjectChange={async () => undefined}
          onModelChange={selectModel}
          onThinkingChange={selectThinking}
          onSubmit={submit}
        />
        {draft.loadError ? <div className="composer-error">{draft.loadError}</div> : null}
      </div>
    </AssistantRuntimeProvider>
  );
}
