import type { AssistantRuntime } from "@assistant-ui/react";
import { type ShouldBlockFn, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftSessionConfig, Project, ThinkingLevel } from "../../../shared/contracts.ts";
import { toPiImageInputs } from "../runtime/image-attachments.ts";
import { Button } from "../shared/ui/button.tsx";
import { Dialog } from "../shared/ui/dialog.tsx";
import { DialogContent } from "../shared/ui/dialog-content.tsx";
import { DialogDescription } from "../shared/ui/dialog-description.tsx";
import { DialogTitle } from "../shared/ui/dialog-title.tsx";
import { DraftComposerThread } from "./chat/draft-composer-thread.tsx";
import { EmptyChatState } from "./chat/empty-chat-state.tsx";

type DraftPhase = "loading" | "editing" | "materializing" | "no-project";

/** Loads draft configuration and materializes the first accepted prompt into a routed Pi session. */
export function NewSessionSurface({ runtime }: { runtime: AssistantRuntime }) {
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(search.projectId ?? null);
  const [config, setConfig] = useState<DraftSessionConfig | null>(null);
  const [phase, setPhase] = useState<DraftPhase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const submitInFlight = useRef(false);
  const committedTarget = useRef<{ projectId: string; threadId: string } | null>(null);
  const allowNavigation = useRef(false);
  const draftIsDirty = useCallback(() => !runtime.thread.composer.getState().isEmpty, [runtime]);
  const shouldBlockNavigation = useCallback<ShouldBlockFn>(
    ({ next }) => next.pathname !== "/new" && !allowNavigation.current && draftIsDirty(),
    [draftIsDirty],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: draftIsDirty,
    withResolver: true,
  });

  useEffect(() => {
    let active = true;
    void window.desktop.projects
      .list()
      .then((next) => {
        if (!active) return;
        const available = next.filter((project) => project.available);
        setProjects(available);
        setProjectId((selected) =>
          available.some((project) => project.id === selected) ? selected : (available[0]?.id ?? null),
        );
        setPhase(available.length ? "editing" : "no-project");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setLoadError(reason instanceof Error ? reason.message : String(reason));
        setPhase("no-project");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setConfig(null);
      return;
    }
    let active = true;
    setConfig(null);
    setLoadError(null);
    void window.desktop.sessions
      .getDraftConfig(projectId)
      .then((next) => {
        if (active) setConfig(next);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const project = projects.find((entry) => entry.id === projectId) ?? null;

  async function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    await navigate({ to: "/new", search: { projectId: nextProjectId }, replace: true });
  }

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
    if (committedTarget.current) {
      submitInFlight.current = true;
      allowNavigation.current = true;
      try {
        await navigate({
          to: "/projects/$projectId/session/$threadId",
          params: committedTarget.current,
          replace: true,
        });
      } finally {
        allowNavigation.current = false;
        submitInFlight.current = false;
      }
      return;
    }
    if (!projectId || !config?.model || config.readiness.state !== "ready") return;
    const composer = runtime.thread.composer;
    const state = composer.getState();
    if (state.isEmpty) return;
    submitInFlight.current = true;
    setPhase("materializing");
    let threadId: string | null = null;
    let rejectedByPi = false;
    try {
      const images = await toPiImageInputs(state.attachments);
      const bootstrap = await window.desktop.sessions.create({
        projectId,
        createRequestId: crypto.randomUUID(),
        model: { provider: config.model.provider, id: config.model.id },
        thinkingLevel: config.thinkingLevel,
      });
      threadId = bootstrap.threadId;
      const result = await window.desktop.sessions.prompt({
        requestId: crypto.randomUUID(),
        projectId,
        threadId,
        text: state.text,
        images,
      });
      if (!result.accepted) {
        rejectedByPi = true;
        throw new Error(result.error ?? "Pi 未接受此输入");
      }
      committedTarget.current = { projectId, threadId };
      allowNavigation.current = true;
      await navigate({ to: "/projects/$projectId/session/$threadId", params: committedTarget.current, replace: true });
    } catch (reason) {
      if (threadId && rejectedByPi) {
        await window.desktop.sessions.remove(projectId, threadId).catch(() => undefined);
      } else if (threadId && !committedTarget.current) {
        committedTarget.current = { projectId, threadId };
        setLoadError("会话已创建，但发送结果未知。再次发送将重试打开该会话。");
      }
      setPhase("editing");
      throw reason;
    } finally {
      allowNavigation.current = false;
      submitInFlight.current = false;
    }
  }

  if (phase === "no-project") {
    return (
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <strong>新会话</strong>
          </div>
        </header>
        <div className="workspace-row">
          <main className="chat-workspace">
            <EmptyChatState title="没有可用 Project" detail={loadError ?? "请先在侧边栏添加 Project。"} />
          </main>
        </div>
      </main>
    );
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="topbar-title">
          <strong>新会话</strong>
        </div>
      </header>
      <div className="workspace-row">
        <main className="chat-workspace">
          <DraftComposerThread
            projects={projects}
            project={project}
            config={config}
            configLoading={config === null}
            phase={phase === "materializing" ? "materializing" : "editing"}
            onProjectChange={selectProject}
            onModelChange={selectModel}
            onThinkingChange={selectThinking}
            onSubmit={submit}
          />
        </main>
      </div>
      {loadError ? <div className="composer-error">{loadError}</div> : null}
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
      >
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogTitle>丢弃新会话草稿</DialogTitle>
          <DialogDescription>当前输入尚未发送，离开会丢弃这些内容。</DialogDescription>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => blocker.status === "blocked" && blocker.reset()}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => blocker.status === "blocked" && blocker.proceed()}>
              丢弃并离开
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
