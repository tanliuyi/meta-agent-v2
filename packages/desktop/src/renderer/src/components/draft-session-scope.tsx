import { type ReactNode, useMemo } from "react";
import {
  type CachedSessionRecord,
  type CachedSessionSummary,
  createSessionRecordStores,
  sessionRecordKey,
} from "../runtime/pi-session-store.ts";
import { useDraftSession } from "../state/draft-session-context.tsx";
import { DRAFT_THREAD_ID, useDraftWorkbench } from "../state/draft-workbench-context.tsx";
import { type SessionScope, SessionScopeProvider } from "./session-context.tsx";

const subscribeNoop = (): (() => void) => () => undefined;

/** 草稿无真实会话活动：summary 恒为就绪空态，快照缓存为模块级常量供 useSyncExternalStore 对比。 */
const DRAFT_SUMMARY_SNAPSHOT: CachedSessionSummary = {
  composerEmpty: true,
  running: false,
  loading: false,
  hasPendingAttachments: false,
  connectionState: "ready",
};

/**
 * 为新会话草稿提供 SessionScope：伪 record 的 identity.projectId 跟随草稿选择，
 * threadId 使用固定占位（DRAFT_THREAD_ID）；workbench store 桥接页面级草稿状态，
 * control/connection 等会话态恒为 null/就绪占位（草稿树中无真实会话组件消费）。
 * 这样 BottomTerminal / WorkbenchPanel / TerminalView 等 session-scoped 组件
 * 可在新会话页面直接复用，无需感知草稿与真实会话的差异。
 */
export function DraftSessionScopeProvider({ children }: { children: ReactNode }) {
  const { projectId } = useDraftSession();
  const draftWorkbench = useDraftWorkbench();
  const record = useMemo<CachedSessionRecord>(
    () => ({
      key: sessionRecordKey(projectId ?? "", DRAFT_THREAD_ID),
      identity: { projectId: projectId ?? "", threadId: DRAFT_THREAD_ID },
      generation: 1,
      lastAccessedAt: Date.now(),
      stores: {
        ...createSessionRecordStores(),
        control: {
          getSnapshot: () => null,
          replace: () => undefined,
          apply: () => undefined,
          subscribe: subscribeNoop,
        },
        composerDraft: {
          getSnapshot: () => ({ text: "", attachments: [] }),
          setSnapshot: () => undefined,
        },
        workbench: draftWorkbench.workbenchStore,
        summary: {
          getSnapshot: () => DRAFT_SUMMARY_SNAPSHOT,
          setRunning: () => undefined,
          setConnectionState: () => undefined,
          setComposerDirty: () => undefined,
          set: () => undefined,
          subscribe: subscribeNoop,
        },
        runActivity: {
          hasParticipated: () => false,
          markParticipated: () => undefined,
          reset: () => undefined,
          sync: () => undefined,
        },
        disclosure: {
          get: () => undefined,
          set: () => undefined,
          delete: () => undefined,
        },
        connection: {
          getSnapshot: () => "ready",
          setState: () => undefined,
          subscribe: subscribeNoop,
        },
      },
    }),
    [draftWorkbench.workbenchStore, projectId],
  );
  const scope = useMemo<SessionScope>(
    () => ({
      record,
      active: true,
      commandsReady: false,
      modelsRefreshing: false,
      refreshModels: async () => undefined,
      setModel: async () => undefined,
      setThinking: async () => undefined,
      updateWorkbench: draftWorkbench.updateWorkbench,
      // 草稿标记：供 BottomTerminal/WorkbenchPanel 等组件放宽 control 就绪检查。
      isDraft: true,
      draftWorkbenchTabs: draftWorkbench.tabs,
    }),
    [draftWorkbench.tabs, draftWorkbench.updateWorkbench, record],
  );
  return <SessionScopeProvider scope={scope}>{children}</SessionScopeProvider>;
}
