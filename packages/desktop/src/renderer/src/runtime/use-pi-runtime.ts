import type { AssistantRuntime } from "@assistant-ui/react";
import { type AgUiAssistantRuntime, type UseAgUiThreadListAdapter, useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  Project,
  SessionBootstrap,
  SessionCreateInput,
  Thread,
  WorkbenchState,
} from "../../../shared/contracts.ts";
import { resolveDesktopAdapterThread } from "../state/thread-list-commands.ts";
import { convertAgUiMessages, messageRepository } from "./ag-ui-messages.ts";
import { type ComposerReseed, prepareDraftSubmission, reseedComposer } from "./draft-session.ts";
import { ElectronPiAgent } from "./electron-pi-agent.ts";
import { imageAttachmentAdapter } from "./image-attachments.ts";
import { sessionEventBus } from "./session-event-bus.ts";

export interface PreparedThread {
  bootstrap: SessionBootstrap;
  workbench: WorkbenchState;
}

export type PreparedDraftSubmission =
  | (PreparedThread & { sent: true })
  | (PreparedThread & { sent: false; reseed: ComposerReseed });

export interface DesktopThreadActions {
  open(project: Project, threadId: string): Promise<PreparedThread>;
  enterDraft(): Promise<void>;
  submitDraft(
    input: { project: Project; model: SessionCreateInput["model"]; thinkingLevel: SessionCreateInput["thinkingLevel"] },
    onPrepared: () => void,
  ): Promise<PreparedDraftSubmission>;
  discardDraft(): Promise<PreparedThread | null>;
  rename(project: Project, threadId: string, title: string): Promise<void>;
  archive(project: Project, threadId: string, archived: boolean): Promise<void>;
  remove(project: Project, threadId: string): Promise<void>;
  detach(): Promise<void>;
}

interface PiRuntimeOptions {
  projects: Project[];
  project: Project | null;
  threadCatalogs: Readonly<Record<string, Thread[]>>;
  threadId: string | null;
  isSendDisabled: boolean;
}

interface PreparedSwitch extends PreparedThread {
  messages: ReturnType<typeof convertAgUiMessages>;
}

/** 使用 assistant-ui thread adapter 管理跨 Pi session 的 hydrate 与切换。 */
export function usePiRuntime(options: PiRuntimeOptions): {
  runtime: AgUiAssistantRuntime;
  actions: DesktopThreadActions;
} {
  const runtimeRef = useRef<AgUiAssistantRuntime | null>(null);
  const agent = useMemo(
    () =>
      new ElectronPiAgent(
        (messages) => {
          const activeRuntime = runtimeRef.current;
          if (!activeRuntime) return;
          activeRuntime.thread.import(messageRepository(convertAgUiMessages(messages)));
        },
        (message) => {
          const activeRuntime = runtimeRef.current;
          if (!activeRuntime) return;
          const converted = convertAgUiMessages([message])[0];
          if (converted?.role !== "user") return;
          activeRuntime.thread.append({
            role: "user",
            content: converted.content,
            attachments: converted.attachments,
            metadata: converted.metadata,
            createdAt: converted.createdAt,
            startRun: false,
          });
        },
      ),
    [],
  );
  const projectRef = useRef(options.project);
  const targetProjectRef = useRef<Project | null>(null);
  const targetCreateInputRef = useRef<SessionCreateInput | null>(null);
  const preparedRef = useRef<PreparedSwitch | null>(null);
  const createdThreadRef = useRef<{ projectId: string; threadId: string } | null>(null);
  const pendingReseedRef = useRef<{ projectId: string; threadId: string; reseed: ComposerReseed } | null>(null);
  const committedThreadRef = useRef<{ projectId: string; threadId: string } | null>(null);
  const draftModeRef = useRef(false);
  const switchGeneration = useRef(0);
  const targetGenerationRef = useRef(0);
  projectRef.current = options.project;

  const threadList = useMemo<UseAgUiThreadListAdapter>(() => {
    const project = options.project;
    const catalog = options.projects.flatMap((item) =>
      (options.threadCatalogs[item.id] ?? []).map((thread) => ({ project: item, thread })),
    );
    const regular = catalog.filter(({ thread }) => !thread.archived);
    const archived = catalog.filter(({ thread }) => thread.archived);
    const currentProject = () => targetProjectRef.current ?? projectRef.current;
    const resolveAdapterThread = (adapterThreadId: string) =>
      resolveDesktopAdapterThread(adapterThreadId, options.projects, options.threadCatalogs, targetProjectRef.current);
    return {
      threadId: project && options.threadId ? threadAdapterId(project.id, options.threadId) : undefined,
      threads: regular.map(({ project: item, thread }) => ({
        id: threadAdapterId(item.id, thread.id),
        remoteId: thread.id,
        title: thread.title,
        status: "regular" as const,
        custom: { projectId: item.id },
      })),
      archivedThreads: archived.map(({ project: item, thread }) => ({
        id: threadAdapterId(item.id, thread.id),
        remoteId: thread.id,
        title: thread.title,
        status: "archived" as const,
        custom: { projectId: item.id },
      })),
      async onSwitchToThread(adapterThreadId) {
        const generation = targetGenerationRef.current;
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        const [bootstrap, workbench] = await Promise.all([
          sessionEventBus.attach(activeProject.id, threadId),
          window.desktop.workbench.get(activeProject.id, threadId),
        ]);
        if (generation !== switchGeneration.current) throw new DOMException("Thread switch superseded", "AbortError");
        await agent.attach(bootstrap);
        const messages = convertAgUiMessages(bootstrap.messages);
        preparedRef.current = { bootstrap, workbench, messages };
        return { messages, state: bootstrap.state };
      },
      async onSwitchToNewThread() {
        const generation = targetGenerationRef.current;
        const activeProject = currentProject();
        if (!activeProject) throw new Error("创建 session 前必须先选择 Project");
        const createInput = targetCreateInputRef.current;
        if (!createInput || createInput.projectId !== activeProject.id) throw new Error("新会话创建配置不存在");
        const created = await window.desktop.sessions.create(createInput);
        createdThreadRef.current = { projectId: activeProject.id, threadId: created.threadId };
        const [bootstrap, workbench] = await Promise.all([
          sessionEventBus.attach(activeProject.id, created.threadId),
          window.desktop.workbench.get(activeProject.id, created.threadId),
        ]);
        if (generation !== switchGeneration.current) throw new DOMException("Thread creation superseded", "AbortError");
        await agent.attach(bootstrap);
        preparedRef.current = { bootstrap, workbench, messages: [] };
      },
      onRename: async (adapterThreadId, title) => {
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        await window.desktop.sessions.rename(activeProject.id, threadId, title);
      },
      onArchive: async (adapterThreadId) => {
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        await window.desktop.sessions.archive(activeProject.id, threadId, true);
      },
      onUnarchive: async (adapterThreadId) => {
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        await window.desktop.sessions.archive(activeProject.id, threadId, false);
      },
      onDelete: async (adapterThreadId) => {
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        await window.desktop.sessions.remove(activeProject.id, threadId);
      },
    };
  }, [agent, options.project, options.projects, options.threadCatalogs, options.threadId]);

  const cancel = useCallback(() => {
    const attached = agent.attachedSession;
    if (!attached) return;
    agent.cancelActive();
    void window.desktop.sessions
      .cancel(attached.projectId, attached.threadId)
      .then(() => sessionEventBus.resync(attached.projectId, attached.threadId))
      .catch((error: unknown) => console.error("取消 Pi run 失败", error));
  }, [agent]);

  const runtime = useAgUiRuntime({
    agent,
    adapters: { attachments: imageAttachmentAdapter, threadList },
    onCancel: cancel,
    isSendDisabled: options.isSendDisabled,
  });
  runtimeRef.current = runtime;

  useEffect(
    () =>
      sessionEventBus.onResync((bootstrap) => {
        void agent
          .attach(bootstrap)
          .then(() => {
            const messages = convertAgUiMessages(bootstrap.messages);
            runtime.thread.import(messageRepository(messages));
            if (!joinActiveRun(runtime, bootstrap, messages)) window.desktop.sessions.flush();
          })
          .catch((error: unknown) => console.error("恢复 Pi session 失败", error));
      }),
    [agent, runtime],
  );

  const projectId = options.project?.id;
  useEffect(() => {
    const pending = pendingReseedRef.current;
    if (!pending || pending.projectId !== projectId || pending.threadId !== options.threadId) return;
    pendingReseedRef.current = null;
    void reseedComposer(runtime.thread.composer, pending.reseed).catch((error: unknown) =>
      console.error("恢复新会话 Composer 失败", error),
    );
  }, [options.threadId, projectId, runtime]);

  const actions = useMemo<DesktopThreadActions>(() => {
    const resetToDraft = async () => {
      sessionEventBus.detach();
      await agent.detach();
      runtime.thread.reset();
      targetProjectRef.current = null;
      targetCreateInputRef.current = null;
      preparedRef.current = null;
    };
    const restoreCommittedThread = async () => {
      const committed = committedThreadRef.current;
      if (!committed) {
        await resetToDraft();
        return null;
      }
      const [bootstrap, workbench] = await Promise.all([
        sessionEventBus.attach(committed.projectId, committed.threadId),
        window.desktop.workbench.get(committed.projectId, committed.threadId),
      ]);
      await agent.attach(bootstrap);
      const messages = convertAgUiMessages(bootstrap.messages);
      runtime.thread.import(messageRepository(messages));
      if (!joinActiveRun(runtime, bootstrap, messages)) window.desktop.sessions.flush();
      return { bootstrap, workbench };
    };
    return {
      async open(project, threadId) {
        const wasDraft = draftModeRef.current;
        const generation = ++switchGeneration.current;
        targetGenerationRef.current = generation;
        targetProjectRef.current = project;
        preparedRef.current = null;
        try {
          await runtime.threads.switchToThread(threadAdapterId(project.id, threadId));
          if (generation !== switchGeneration.current) throw new DOMException("Thread switch superseded", "AbortError");
          const prepared = readPrepared(preparedRef);
          if (!prepared || prepared.bootstrap.threadId !== threadId)
            throw new Error("assistant-ui thread hydrate 未完成");
          if (!joinActiveRun(runtime, prepared.bootstrap, prepared.messages)) window.desktop.sessions.flush();
          committedThreadRef.current = { projectId: project.id, threadId };
          draftModeRef.current = false;
          return prepared;
        } catch (error) {
          if (generation === switchGeneration.current) {
            if (wasDraft) await resetToDraft();
            else await restoreCommittedThread();
          }
          throw error;
        } finally {
          if (generation === switchGeneration.current) {
            targetProjectRef.current = null;
          }
        }
      },
      async enterDraft() {
        switchGeneration.current += 1;
        pendingReseedRef.current = null;
        createdThreadRef.current = null;
        draftModeRef.current = true;
        await resetToDraft();
      },
      async submitDraft(input, onPrepared) {
        const submission = await prepareDraftSubmission(runtime.thread.composer.getState());
        onPrepared();
        const { project } = input;
        const generation = ++switchGeneration.current;
        targetGenerationRef.current = generation;
        targetProjectRef.current = project;
        targetCreateInputRef.current = {
          projectId: project.id,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
        };
        preparedRef.current = null;
        createdThreadRef.current = null;
        try {
          await runtime.threads.switchToNewThread();
          if (generation !== switchGeneration.current)
            throw new DOMException("Thread creation superseded", "AbortError");
          const prepared = readPrepared(preparedRef);
          if (!prepared) throw new Error("assistant-ui new thread hydrate 未完成");
          committedThreadRef.current = { projectId: project.id, threadId: prepared.bootstrap.threadId };
          draftModeRef.current = false;
          if (prepared.bootstrap.control.readiness.state !== "ready") {
            pendingReseedRef.current = {
              projectId: project.id,
              threadId: prepared.bootstrap.threadId,
              reseed: submission.reseed,
            };
            window.desktop.sessions.flush();
            return { ...prepared, sent: false, reseed: submission.reseed };
          }
          runtime.thread.append(submission.message);
          void runtime.thread.composer
            .reset()
            .catch((error: unknown) => console.error("清空已发送 Composer 失败", error));
          return { ...prepared, sent: true };
        } catch (error) {
          const created = createdThreadRef.current as { projectId: string; threadId: string } | null;
          if (created) await Promise.allSettled([window.desktop.sessions.remove(created.projectId, created.threadId)]);
          if (generation === switchGeneration.current) {
            pendingReseedRef.current = null;
            committedThreadRef.current = null;
            draftModeRef.current = true;
            await resetToDraft();
          }
          throw error;
        } finally {
          if (generation === switchGeneration.current) {
            targetProjectRef.current = null;
            targetCreateInputRef.current = null;
          }
        }
      },
      async discardDraft() {
        switchGeneration.current += 1;
        pendingReseedRef.current = null;
        createdThreadRef.current = null;
        draftModeRef.current = false;
        return restoreCommittedThread();
      },
      async rename(project, threadId, title) {
        await runtime.threads.getItemById(threadAdapterId(project.id, threadId)).rename(title);
      },
      async archive(project, threadId, archived) {
        const item = runtime.threads.getItemById(threadAdapterId(project.id, threadId));
        if (archived) await item.archive();
        else await item.unarchive();
      },
      async remove(project, threadId) {
        await runtime.threads.getItemById(threadAdapterId(project.id, threadId)).delete();
      },
      async detach() {
        switchGeneration.current += 1;
        sessionEventBus.detach();
        await agent.detach();
        runtime.thread.reset();
        targetProjectRef.current = null;
        targetCreateInputRef.current = null;
        preparedRef.current = null;
        createdThreadRef.current = null;
        pendingReseedRef.current = null;
        committedThreadRef.current = null;
        draftModeRef.current = false;
      },
    };
  }, [agent, runtime]);

  return { runtime, actions };
}

function joinActiveRun(
  runtime: AssistantRuntime,
  bootstrap: SessionBootstrap,
  messages: ReturnType<typeof convertAgUiMessages>,
): boolean {
  if (!bootstrap.activeRun) return false;
  runtime.thread.startRun({ parentId: messages.at(-1)?.id ?? null });
  return true;
}

function threadAdapterId(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

function readPrepared(reference: { current: PreparedSwitch | null }): PreparedSwitch | null {
  return reference.current;
}
