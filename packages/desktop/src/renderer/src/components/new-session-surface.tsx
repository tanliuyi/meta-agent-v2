import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { ThinkingLevel } from "../../../shared/contracts.ts";
import { toPiImageInputs } from "../runtime/image-attachments.ts";
import { selectProjects } from "../state/desktop-selectors.ts";
import { dispatchDesktop } from "../state/desktop-store.ts";
import { useDesktopStore } from "../state/desktop-store-context.tsx";
import {
  isStaleExtensionSetError,
  materializeDraftSession,
  selectDraftModel,
  selectDraftThinkingLevel,
} from "../state/draft-creation.ts";
import {
  applyStoredDraftSelection,
  persistDraftSelection,
  readStoredDraftProject,
  writeStoredDraftProject,
} from "../state/draft-selection-preference.ts";
import { useDraftSession } from "../state/draft-session-context.tsx";
import { useSessionCache } from "../state/session-cache-context.tsx";
import { resolveDraftProjectId, useDraftSearchParams } from "../state/session-navigation.ts";
import { DraftComposerThread } from "./chat/draft-composer-thread.tsx";
import { EmptyChatState } from "./chat/empty-chat-state.tsx";
import { NewSessionShell } from "./new-session-shell.tsx";

/** Loads draft configuration and materializes the first accepted prompt into a routed Pi session. */
export function NewSessionSurface() {
  const search = useDraftSearchParams();
  const navigate = useNavigate();
  const sessionCache = useSessionCache();
  const desktopStore = useDesktopStore();
  const draft = useDraftSession();
  const { runtime, projectId, setProjectId, config, setConfig, configProjectId, setConfigProjectId, phase, setPhase } =
    draft;
  const {
    loadError,
    setLoadError,
    navigationTarget,
    setNavigationTarget,
    submitInFlight,
    createRequestIds,
    projectFallbackAllowed,
  } = draft;
  const catalogProjects = useStore(desktopStore, selectProjects);
  const catalogLoading = useStore(desktopStore, (state) => state.loading);
  const projects = useMemo(() => catalogProjects.filter((project) => project.available), [catalogProjects]);

  useEffect(() => {
    if (!navigationTarget) return;
    const target = navigationTarget;
    setNavigationTarget(null);
    void navigate({ to: "/projects/$projectId/session/$threadId", params: target, replace: true }).catch(
      (reason: unknown) => setLoadError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [navigate, navigationTarget, setLoadError, setNavigationTarget]);

  useEffect(() => {
    if (catalogLoading) {
      setPhase((current) => (current === "materializing" ? current : "loading"));
      return;
    }
    setProjectId((selected) => {
      const resolved = resolveDraftProjectId(
        projects,
        search.projectId,
        selected,
        projectFallbackAllowed.current,
        readStoredDraftProject(),
      );
      if (search.projectId && resolved === search.projectId) projectFallbackAllowed.current = true;
      else if (selected && resolved === null) projectFallbackAllowed.current = false;
      if (resolved) writeStoredDraftProject(resolved);
      return resolved;
    });
    setPhase((current) => {
      if (current === "materializing") return current;
      return projects.length > 0 ? "editing" : "no-project";
    });
  }, [catalogLoading, projects, search.projectId]);

  useEffect(() => {
    if (!catalogLoading && projectId && !projects.some((project) => project.id === projectId)) {
      setConfig(null);
      setConfigProjectId(null);
      setLoadError(null);
    }
  }, [catalogLoading, projectId, projects]);

  useEffect(() => {
    setConfig(null);
    setConfigProjectId(null);
  }, [setConfig, setConfigProjectId]);

  useEffect(() => {
    if (catalogLoading) return;
    if (!projectId) {
      setConfig(null);
      setConfigProjectId(null);
      return;
    }
    if (configProjectId === projectId) return;
    let active = true;
    setConfig(null);
    setLoadError(null);
    void window.desktop.sessions
      .getDraftConfig(projectId)
      .then((next) => {
        if (!active) return;
        setConfig(applyStoredDraftSelection(next, projectId));
        setConfigProjectId(projectId);
        setLoadError(null);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [catalogLoading, configProjectId, projectId, setConfig, setConfigProjectId, setLoadError]);

  const project = projects.find((entry) => entry.id === projectId) ?? null;

  useEffect(() => {
    sessionCache.setActiveKey(null);
  }, [sessionCache]);

  async function selectProject(nextProjectId: string) {
    projectFallbackAllowed.current = true;
    writeStoredDraftProject(nextProjectId);
    setProjectId(nextProjectId);
    await navigate({ to: "/new", search: { projectId: nextProjectId }, replace: true });
  }

  function selectModel(provider: string, modelId: string) {
    const next = selectDraftModel(config, provider, modelId);
    persistDraftSelection(projectId, next);
    setConfig(next);
  }

  function selectThinking(thinkingLevel: ThinkingLevel) {
    const next = selectDraftThinkingLevel(config, thinkingLevel);
    persistDraftSelection(projectId, next);
    setConfig(next);
  }

  function selectPlugins(enabledPluginIds: string[] | null) {
    if (!config) return;
    setConfig({ ...config, extensions: { ...config.extensions, enabledPluginIds } });
  }

  async function submit() {
    if (submitInFlight.current) return;
    if (!projectId || !config?.model || config.readiness.state !== "ready") return;
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
          model: { provider: config.model.provider, id: config.model.id },
          thinkingLevel: config.thinkingLevel,
          extensionSetGeneration: config.extensions.extensionSetGeneration,
          ...(config.extensions.enabledPluginIds ? { enabledPluginIds: config.extensions.enabledPluginIds } : {}),
          text: state.text,
          images,
        },
        {
          requestIds: createRequestIds,
          sessions: window.desktop.sessions,
          cache: sessionCache,
          onMaterialized(bootstrap) {
            dispatchDesktop(desktopStore, { type: "thread-catalog-added", bootstrap });
          },
        },
      );
      const target = materialized.target;
      const nextProjectId = projects.some((project) => project.id === target.projectId)
        ? target.projectId
        : (projects[0]?.id ?? null);
      await draft.clear(nextProjectId, target);
    } catch (reason) {
      setPhase("editing");
      if (isStaleExtensionSetError(reason)) {
        createRequestIds.delete(projectId);
        setConfig(null);
        setConfigProjectId(null);
      }
      throw reason;
    } finally {
      submitInFlight.current = false;
      sessionCache.setDraftMaterializing(false);
    }
  }

  if (phase === "no-project") {
    return (
      <NewSessionShell disabled={!projectId}>
        <EmptyChatState
          title="没有可用工作区"
          detail={loadError ?? "通用工作区不可用，且没有可用的 Project。请添加一个 Project。"}
        />
      </NewSessionShell>
    );
  }

  return (
    <NewSessionShell disabled={!projectId}>
      <DraftComposerThread
        projects={projects}
        project={project}
        config={config}
        configLoading={config === null}
        phase={phase === "materializing" ? "materializing" : "editing"}
        error={loadError}
        diagnostics={config?.extensions.diagnostics}
        onProjectChange={selectProject}
        onModelChange={selectModel}
        onThinkingChange={selectThinking}
        onPluginsChange={selectPlugins}
        onSubmit={submit}
      />
    </NewSessionShell>
  );
}
