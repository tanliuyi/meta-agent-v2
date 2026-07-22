import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ExternalStoreThreadListAdapter,
  type ExternalThreadQueueAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  Project,
  SessionBootstrap,
  SessionCreateInput,
  Thread,
  WorkbenchState,
} from "../../../shared/contracts.ts";
import { type ComposerReseed, prepareDraftSubmission, reseedComposer } from "./draft-session.ts";
import { imageAttachmentAdapter } from "./image-attachments.ts";
import { PiCommandCoordinator, resolveReloadUserEntry } from "./pi-command-coordinator.ts";
import { PiMessageRepositoryConverter } from "./pi-message-repository.ts";
import { piSessionBus } from "./pi-session-bus.ts";
import { resolveDesktopAdapterThread, threadAdapterId } from "./thread-adapter.ts";

export interface PreparedThread {
  bootstrap: SessionBootstrap;
  workbench: WorkbenchState;
}

export type PreparedDraftSubmission =
  | (PreparedThread & { sent: true })
  | (PreparedThread & { sent: false; reseed: ComposerReseed });

export interface DesktopThreadActions {
  open(project: Project, threadId: string): Promise<PreparedThread>;
  commit(prepared: PreparedThread): void;
  /** 从指定 entry fork 当前会话为新会话，返回新会话 id。 */
  branch(sourceEntryId: string, position?: "at" | "before"): Promise<string>;
  enterDraft(): Promise<void>;
  submitDraft(input: {
    project: Project;
    model: SessionCreateInput["model"];
    thinkingLevel: SessionCreateInput["thinkingLevel"];
  }): Promise<PreparedDraftSubmission>;
  discardDraft(): Promise<PreparedThread | null>;
  rename(project: Project, threadId: string, title: string): Promise<void>;
  archive(project: Project, threadId: string, archived: boolean): Promise<void>;
  remove(project: Project, threadId: string): Promise<void>;
  clearQueue(): Promise<void>;
  detach(): Promise<void>;
}

interface PiRuntimeOptions {
  projects: Project[];
  project: Project | null;
  threadCatalogs: Readonly<Record<string, Thread[]>>;
  threadId: string | null;
  isSendDisabled: boolean;
}

interface AttachedTarget {
  projectId: string;
  threadId: string;
  generation: number;
}

interface ThreadIdentity {
  projectId: string;
  threadId: string;
}

/** 使用 assistant-ui External Store Runtime 投影 Pi-native timeline。 */
export function usePiRuntime(options: PiRuntimeOptions): {
  runtime: AssistantRuntime;
  actions: DesktopThreadActions;
} {
  const snapshot = useSyncExternalStore(
    piSessionBus.store.subscribe,
    piSessionBus.store.getSnapshot,
    piSessionBus.store.getSnapshot,
  );
  const converter = useMemo(() => new PiMessageRepositoryConverter(), []);
  const repository = useMemo(() => converter.build(snapshot), [converter, snapshot]);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const targetRef = useRef<AttachedTarget | null>(null);
  const projectRef = useRef(options.project);
  const threadCatalogsRef = useRef(options.threadCatalogs);
  const targetProjectRef = useRef<Project | null>(null);
  const targetCreateInputRef = useRef<SessionCreateInput | null>(null);
  const preparedRef = useRef<PreparedThread | null>(null);
  const createdThreadRef = useRef<{ projectId: string; threadId: string } | null>(null);
  const pendingReseedRef = useRef<{ projectId: string; threadId: string; reseed: ComposerReseed } | null>(null);
  const committedThreadRef = useRef<ThreadIdentity | null>(null);
  const archiveInvalidationRef = useRef<ThreadIdentity | null>(null);
  const draftModeRef = useRef(false);
  const switchGeneration = useRef(0);
  const targetGenerationRef = useRef(0);
  projectRef.current = options.project;
  threadCatalogsRef.current = options.threadCatalogs;

  const coordinator = useMemo(
    () =>
      new PiCommandCoordinator({
        getTarget: () => targetRef.current,
        getComposer: () => runtimeRef.current?.thread.composer ?? null,
        getPhase: () => piSessionBus.store.getSnapshot().phase,
        resolveReloadTarget: (parentId) => resolveReloadUserEntry(piSessionBus.store.getSnapshot(), parentId),
        report: (error) => console.error("Pi command 失败", error),
      }),
    [],
  );

  useEffect(() => {
    coordinator.observeQueue(snapshot.queue);
  }, [coordinator, snapshot.queue]);

  const hydrateThread = useCallback(async (project: Project, threadId: string, generation: number) => {
    const [bootstrap, workbench] = await Promise.all([
      piSessionBus.attach(project.id, threadId),
      window.desktop.workbench.get(project.id, threadId),
    ]);
    if (generation !== switchGeneration.current) throw new DOMException("Thread switch superseded", "AbortError");
    targetRef.current = { projectId: project.id, threadId, generation };
    const prepared = { bootstrap, workbench };
    preparedRef.current = prepared;
    return prepared;
  }, []);

  const isArchivedThread = useCallback((projectId: string, threadId: string): boolean => {
    return threadCatalogsRef.current[projectId]?.some((thread) => thread.id === threadId && thread.archived) ?? false;
  }, []);

  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => {
    const project = options.project;
    const catalog = options.projects.flatMap((item) =>
      (options.threadCatalogs[item.id] ?? []).map((thread) => ({ project: item, thread })),
    );
    const currentProject = () => targetProjectRef.current ?? projectRef.current;
    const resolveAdapterThread = (adapterThreadId: string) =>
      resolveDesktopAdapterThread(adapterThreadId, options.projects, options.threadCatalogs, targetProjectRef.current);
    return {
      threadId: project && options.threadId ? threadAdapterId(project.id, options.threadId) : undefined,
      threads: catalog
        .filter(({ thread }) => !thread.archived)
        .map(({ project: item, thread }) => ({
          id: threadAdapterId(item.id, thread.id),
          remoteId: thread.id,
          title: thread.title,
          status: "regular",
          custom: { projectId: item.id },
        })),
      archivedThreads: catalog
        .filter(({ thread }) => thread.archived)
        .map(({ project: item, thread }) => ({
          id: threadAdapterId(item.id, thread.id),
          remoteId: thread.id,
          title: thread.title,
          status: "archived",
          custom: { projectId: item.id },
        })),
      async onSwitchToThread(adapterThreadId) {
        const generation = targetGenerationRef.current;
        const { project: activeProject, threadId } = resolveAdapterThread(adapterThreadId);
        if (isArchivedThread(activeProject.id, threadId)) throw new Error("已归档 session 不可打开");
        await hydrateThread(activeProject, threadId, generation);
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
          piSessionBus.attach(activeProject.id, created.threadId),
          window.desktop.workbench.get(activeProject.id, created.threadId),
        ]);
        if (generation !== switchGeneration.current) throw new DOMException("Thread creation superseded", "AbortError");
        targetRef.current = { projectId: activeProject.id, threadId: created.threadId, generation };
        preparedRef.current = { bootstrap, workbench };
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
  }, [hydrateThread, isArchivedThread, options.project, options.projects, options.threadCatalogs, options.threadId]);

  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: snapshot.queue.map(({ id, prompt }) => ({ id, prompt })),
      enqueue: coordinator.enqueue,
      steer: coordinator.unsupportedQueueOperation,
      remove: coordinator.unsupportedQueueOperation,
      clear: coordinator.observeFrameworkClear,
    }),
    [coordinator, snapshot.queue],
  );
  const canMutateBranch = snapshot.phase === "idle" && !options.isSendDisabled && Boolean(targetRef.current);
  const isAgentRunning = snapshot.phase === "running" || snapshot.phase === "retrying";
  const isLoading = snapshot.phase === "compacting" || snapshot.phase === "tree-navigation";
  const isSendDisabled =
    options.isSendDisabled ||
    snapshot.phase === "retrying" ||
    snapshot.phase === "compacting" ||
    snapshot.phase === "tree-navigation";
  /** assistant-ui 按 adapter identity 短路；无关 Desktop render 必须复用同一个对象。 */
  const runtimeAdapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messageRepository: repository,
      isRunning: isAgentRunning,
      isLoading,
      isSendDisabled,
      onNew: coordinator.rejectUnexpectedOnNew,
      queue,
      onEdit: canMutateBranch ? coordinator.edit : undefined,
      onReload: canMutateBranch ? coordinator.reload : undefined,
      onCancel: snapshot.phase === "idle" ? undefined : coordinator.cancel,
      adapters: { attachments: options.isSendDisabled ? undefined : imageAttachmentAdapter, threadList },
      unstable_enableToolInvocations: false,
    }),
    [
      canMutateBranch,
      coordinator,
      isAgentRunning,
      isLoading,
      isSendDisabled,
      options.isSendDisabled,
      queue,
      repository,
      snapshot.phase,
      threadList,
    ],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>(runtimeAdapter);
  runtimeRef.current = runtime;

  useEffect(
    () =>
      piSessionBus.onResync(() => {
        piSessionBus.flush();
      }),
    [],
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
    const clearCommittedThread = () => {
      committedThreadRef.current = null;
      archiveInvalidationRef.current = null;
    };
    const resetToDraft = async () => {
      piSessionBus.detach();
      targetRef.current = null;
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
      const committedCatalog = threadCatalogsRef.current[committed.projectId];
      const committedEntry = committedCatalog?.find(({ id }) => id === committed.threadId);
      if (!committedEntry || committedEntry.archived) {
        clearCommittedThread();
        await resetToDraft();
        return null;
      }
      const generation = switchGeneration.current;
      const [bootstrap, workbench] = await Promise.all([
        piSessionBus.attach(committed.projectId, committed.threadId),
        window.desktop.workbench.get(committed.projectId, committed.threadId),
      ]);
      if (generation !== switchGeneration.current) return null;
      const currentCommitted = committedThreadRef.current;
      if (currentCommitted?.projectId !== committed.projectId || currentCommitted.threadId !== committed.threadId) {
        await resetToDraft();
        return null;
      }
      targetRef.current = { ...committed, generation };
      piSessionBus.commit(bootstrap);
      piSessionBus.flush();
      return { bootstrap, workbench };
    };
    return {
      async open(project, threadId) {
        if (isArchivedThread(project.id, threadId)) throw new Error("已归档 session 不可打开");
        const wasDraft = draftModeRef.current;
        const generation = ++switchGeneration.current;
        targetGenerationRef.current = generation;
        targetProjectRef.current = project;
        preparedRef.current = null;
        try {
          await hydrateThread(project, threadId, generation);
          if (generation !== switchGeneration.current) throw new DOMException("Thread switch superseded", "AbortError");
          const prepared = readRef(preparedRef);
          if (!prepared || prepared.bootstrap.threadId !== threadId)
            throw new Error("assistant-ui thread hydrate 未完成");
          return prepared;
        } catch (error) {
          if (generation === switchGeneration.current) {
            if (wasDraft) await resetToDraft();
            else await restoreCommittedThread();
          }
          throw error;
        } finally {
          if (generation === switchGeneration.current) targetProjectRef.current = null;
        }
      },
      async branch(sourceEntryId, position) {
        const result = await coordinator.branch(sourceEntryId, position);
        return result.branchThreadId;
      },
      commit(prepared) {
        piSessionBus.commit(prepared.bootstrap);
        archiveInvalidationRef.current = null;
        committedThreadRef.current = {
          projectId: prepared.bootstrap.projectId,
          threadId: prepared.bootstrap.threadId,
        };
        draftModeRef.current = false;
        piSessionBus.flush();
      },
      async enterDraft() {
        switchGeneration.current += 1;
        pendingReseedRef.current = null;
        createdThreadRef.current = null;
        draftModeRef.current = true;
        await resetToDraft();
      },
      async submitDraft(input) {
        const submission = await prepareDraftSubmission(runtime.thread.composer.getState());
        const { project } = input;
        const generation = ++switchGeneration.current;
        targetGenerationRef.current = generation;
        targetProjectRef.current = project;
        targetCreateInputRef.current = {
          projectId: project.id,
          createRequestId: crypto.randomUUID(),
          model: input.model,
          thinkingLevel: input.thinkingLevel,
        };
        preparedRef.current = null;
        createdThreadRef.current = null;
        try {
          await runtime.threads.switchToNewThread();
          if (generation !== switchGeneration.current)
            throw new DOMException("Thread creation superseded", "AbortError");
          const prepared = readRef(preparedRef);
          if (!prepared) throw new Error("assistant-ui new thread hydrate 未完成");
          piSessionBus.commit(prepared.bootstrap);
          archiveInvalidationRef.current = null;
          committedThreadRef.current = { projectId: project.id, threadId: prepared.bootstrap.threadId };
          draftModeRef.current = false;
          if (prepared.bootstrap.control.readiness.state !== "ready") {
            pendingReseedRef.current = {
              projectId: project.id,
              threadId: prepared.bootstrap.threadId,
              reseed: submission.reseed,
            };
            piSessionBus.flush();
            return { ...prepared, sent: false, reseed: submission.reseed };
          }
          await runtime.thread.append(submission.message);
          await runtime.thread.composer.reset();
          piSessionBus.flush();
          return { ...prepared, sent: true };
        } catch (error) {
          const created = readRef(createdThreadRef);
          if (created) await Promise.allSettled([window.desktop.sessions.remove(created.projectId, created.threadId)]);
          if (generation === switchGeneration.current) {
            pendingReseedRef.current = null;
            clearCommittedThread();
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
        const committed = committedThreadRef.current;
        const invalidatedCommitted =
          archived && committed?.projectId === project.id && committed.threadId === threadId ? committed : null;
        if (invalidatedCommitted) {
          committedThreadRef.current = null;
          archiveInvalidationRef.current = invalidatedCommitted;
        }
        try {
          if (archived) await item.archive();
          else await item.unarchive();
        } catch (error) {
          if (invalidatedCommitted && archiveInvalidationRef.current === invalidatedCommitted) {
            archiveInvalidationRef.current = null;
            if (!committedThreadRef.current) committedThreadRef.current = invalidatedCommitted;
          }
          throw error;
        }
        if (invalidatedCommitted && archiveInvalidationRef.current === invalidatedCommitted) {
          archiveInvalidationRef.current = null;
        }
      },
      async remove(project, threadId) {
        const generation = switchGeneration.current;
        await runtime.threads.getItemById(threadAdapterId(project.id, threadId)).delete();
        const pendingReseed = pendingReseedRef.current;
        if (pendingReseed?.projectId === project.id && pendingReseed.threadId === threadId) {
          pendingReseedRef.current = null;
        }
        const created = createdThreadRef.current;
        if (created?.projectId === project.id && created.threadId === threadId) createdThreadRef.current = null;

        const committed = committedThreadRef.current;
        const invalidated = archiveInvalidationRef.current;
        const committedMatches = committed?.projectId === project.id && committed.threadId === threadId;
        const invalidatedMatches = invalidated?.projectId === project.id && invalidated.threadId === threadId;
        if (invalidatedMatches) archiveInvalidationRef.current = null;
        if (!committedMatches) return;
        clearCommittedThread();
        draftModeRef.current = true;

        const target = targetRef.current;
        if (target?.projectId !== project.id || target.threadId !== threadId) return;
        // 仅原 generation 仍拥有 target 时 detach，避免中断删除期间启动的新 attachment。
        if (generation === switchGeneration.current && target.generation === generation) await resetToDraft();
        else targetRef.current = null;
      },
      async clearQueue() {
        await coordinator.clearQueue(piSessionBus.store.getSnapshot().queue);
      },
      async detach() {
        switchGeneration.current += 1;
        piSessionBus.detach();
        targetRef.current = null;
        targetProjectRef.current = null;
        targetCreateInputRef.current = null;
        preparedRef.current = null;
        createdThreadRef.current = null;
        pendingReseedRef.current = null;
        clearCommittedThread();
        draftModeRef.current = false;
      },
    };
  }, [coordinator, hydrateThread, isArchivedThread, runtime]);

  return { runtime, actions };
}

function readRef<T>(reference: { current: T | null }): T | null {
  return reference.current;
}
