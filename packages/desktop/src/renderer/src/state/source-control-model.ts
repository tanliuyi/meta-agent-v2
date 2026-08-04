import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitCommitResult,
  GitPathsInput,
  GitRepositoryState,
  GitStatusResult,
} from "../../../shared/git-contracts.ts";

/** 状态变化去抖窗口：合并 watcher 广播与操作后的主动刷新。 */
const REFRESH_DEBOUNCE_MS = 250;

export type SourceControlLoadState = "idle" | "loading" | "ready" | "error";

export interface SourceControlModel {
  /** 当前仓库状态快照；无仓库或读取失败时为 null。 */
  state: GitRepositoryState | null;
  loadState: SourceControlLoadState;
  /** 非仓库 / git 缺失 / 解析失败时的说明。 */
  errorMessage: string | null;
  /** 正在刷新（含后台静默刷新）。 */
  refreshing: boolean;
  refresh(): void;
  stage(input: GitPathsInput): Promise<void>;
  unstage(input: GitPathsInput): Promise<void>;
  discard(input: GitPathsInput): Promise<void>;
  commit(message: string): Promise<GitCommitResult>;
}

/**
 * 源代码管理模型层（对应 VS Code ISCMService/ISCMRepository 的投影）：
 * 订阅 main 进程的 git 状态事件，去抖后拉取快照，并封装变更操作。
 * projectId 变化时重建 watcher 订阅，并取消尚未触发的去抖刷新。
 */
export function useSourceControlModel(projectId: string | null): SourceControlModel {
  const [state, setState] = useState<GitRepositoryState | null>(null);
  const [loadState, setLoadState] = useState<SourceControlLoadState>(projectId ? "loading" : "idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++requestGeneration.current;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (!projectId) return;
      setRefreshing(true);
      void window.desktop.git
        .getStatus(projectId)
        .then((result: GitStatusResult) => {
          if (generation !== requestGeneration.current) return;
          if (result.ok) {
            setState(result.state);
            setLoadState("ready");
            setErrorMessage(null);
          } else {
            setState(null);
            setLoadState("error");
            setErrorMessage(result.message);
          }
        })
        .catch((error: unknown) => {
          if (generation !== requestGeneration.current) return;
          setState(null);
          setLoadState("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (generation === requestGeneration.current) setRefreshing(false);
        });
    }, REFRESH_DEBOUNCE_MS);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      requestGeneration.current += 1;
      setState(null);
      setLoadState("idle");
      setErrorMessage(null);
      return;
    }
    setState(null);
    setLoadState("loading");
    setErrorMessage(null);
    void window.desktop.git.watch(projectId);
    const unsubscribe = window.desktop.git.onStatusChanged(projectId, () => refresh());
    refresh();
    return () => {
      requestGeneration.current += 1;
      unsubscribe();
      void window.desktop.git.unwatch(projectId);
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [projectId, refresh]);

  const runAction = useCallback(
    async (action: (input: GitPathsInput) => Promise<void>, paths: string[]): Promise<void> => {
      if (!projectId) return;
      await action({ projectId, paths });
      // main 进程操作成功后也会广播 statusChanged；这里主动刷新以获得即时反馈，由去抖合并。
      refresh();
    },
    [projectId, refresh],
  );

  const stage = useCallback(
    (input: GitPathsInput) => runAction(window.desktop.git.stage, input.paths ?? []),
    [runAction],
  );
  const unstage = useCallback(
    (input: GitPathsInput) => runAction(window.desktop.git.unstage, input.paths ?? []),
    [runAction],
  );
  const discard = useCallback(
    (input: GitPathsInput) => runAction(window.desktop.git.discard, input.paths ?? []),
    [runAction],
  );

  const commit = useCallback(
    async (message: string): Promise<GitCommitResult> => {
      if (!projectId) return { ok: false, message: "没有活跃项目" };
      const result = await window.desktop.git.commit({ projectId, message });
      refresh();
      return result;
    },
    [projectId, refresh],
  );

  return { state, loadState, errorMessage, refreshing, refresh, stage, unstage, discard, commit };
}
