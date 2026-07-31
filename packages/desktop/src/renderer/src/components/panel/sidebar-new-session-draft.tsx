import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { ThinkingLevel } from "../../../../shared/contracts.ts";
import { toPiImageInputs } from "../../runtime/image-attachments.ts";
import { sessionRecordKey } from "../../runtime/pi-session-store.ts";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { selectProjects } from "../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { isStaleExtensionSetError, materializeDraftSession } from "../../state/draft-creation.ts";
import { useDraftSession } from "../../state/draft-session-context.tsx";
import { useSessionCache } from "../../state/session-cache-context.tsx";
import { useSidebarSessions } from "../../state/sidebar-session-context.tsx";
import { DraftComposerThread } from "../chat/draft-composer-thread.tsx";
import { useSessionScope } from "../session-context.tsx";

/**
 * workbench-panel 中的新会话草稿：项目固定为当前主 session 所在项目，
 * 提交后创建主 session 的子会话，并作为侧边栏 tab 打开（不导航主工作区）。
 */
export function SidebarNewSessionDraft() {
  const { record } = useSessionScope();
  const actions = useDesktopActions();
  const sessionCache = useSessionCache();
  const desktopStore = useDesktopStore();
  const sidebarSessions = useSidebarSessions();
  const draft = useDraftSession();
  const { runtime, config, setConfig, phase, setPhase, submitInFlight, createRequestIds, clear } = draft;
  const [loadError, setLoadError] = useState<string | null>(null);
  const projectId = record.identity.projectId;
  const parentThreadId = record.identity.threadId;
  const project =
    useStore(desktopStore, selectProjects).find((entry) => entry.id === projectId && entry.available) ?? null;

  // 加载主 session 所在项目的草稿配置；项目切换（主 session 变化）时重新加载。
  useEffect(() => {
    let active = true;
    setConfig(null);
    setLoadError(null);
    setPhase("editing");
    void window.desktop.sessions
      .getDraftConfig(projectId)
      .then((next) => {
        if (!active) return;
        setConfig(next);
        setLoadError(
          next.extensions.diagnostics.length > 0
            ? next.extensions.diagnostics
                .map((diagnostic) => `${diagnostic.extensionId}: ${diagnostic.message}`)
                .join("\n")
            : null,
        );
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId, setConfig, setPhase]);

  function selectModel(provider: string, modelId: string) {
    setConfig((current) => {
      const model = current?.models.find((entry) => entry.provider === provider && entry.id === modelId);
      if (!current || !model) return current;
      const thinkingLevel = model.thinkingLevels.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : (model.thinkingLevels[0] ?? "off");
      return {
        ...current,
        model: { provider: model.provider, id: model.id, name: model.name },
        thinkingLevel,
        thinkingLevels: model.thinkingLevels,
        readiness: { state: "ready" },
      };
    });
  }

  function selectThinking(thinkingLevel: ThinkingLevel) {
    setConfig((current) => (current?.thinkingLevels.includes(thinkingLevel) ? { ...current, thinkingLevel } : current));
  }

  async function submit() {
    if (submitInFlight.current) return;
    if (!config?.model || config.readiness.state !== "ready") return;
    const composer = runtime.thread.composer;
    const state = composer.getState();
    if (state.isEmpty) return;
    submitInFlight.current = true;
    sessionCache.setDraftMaterializing(true);
    setPhase("materializing");
    try {
      const images = await toPiImageInputs(state.attachments);
      const materialized = await materializeDraftSession(
        {
          projectId,
          parentThreadId,
          model: { provider: config.model.provider, id: config.model.id },
          thinkingLevel: config.thinkingLevel,
          extensionSetGeneration: config.extensions.extensionSetGeneration,
          text: state.text,
          images,
        },
        {
          requestIds: createRequestIds,
          sessions: window.desktop.sessions,
          cache: sessionCache,
          onMaterialized() {
            // 子会话的父级关系由 metadata 索引从 session header 推导，主动刷新目录。
            actions.refreshProjectThreads(projectId);
          },
        },
      );
      const target = materialized.target;
      // 作为侧边栏 tab 打开子会话，主工作区保持在主 session。
      sidebarSessions.openInSidebar({
        key: sessionRecordKey(target.projectId, target.threadId),
        projectId: target.projectId,
        threadId: target.threadId,
        displayName: state.text.trim().slice(0, 48) || "新会话",
      });
      await clear(projectId, target);
      draft.setNavigationTarget(null);
    } catch (reason) {
      setPhase("editing");
      if (isStaleExtensionSetError(reason)) {
        createRequestIds.delete(projectId);
        setConfig(null);
      }
      throw reason;
    } finally {
      submitInFlight.current = false;
      sessionCache.setDraftMaterializing(false);
    }
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="panel-content sidebar-new-session-draft">
        <DraftComposerThread
          projects={project ? [project] : []}
          project={project}
          config={config}
          configLoading={config === null}
          phase={phase === "materializing" ? "materializing" : "editing"}
          fixedProject
          onProjectChange={async () => undefined}
          onModelChange={selectModel}
          onThinkingChange={selectThinking}
          onSubmit={submit}
        />
        {loadError ? <div className="composer-error">{loadError}</div> : null}
      </div>
    </AssistantRuntimeProvider>
  );
}
