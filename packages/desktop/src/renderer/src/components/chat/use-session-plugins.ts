import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftSelectablePlugin } from "../../../../shared/desktop-extension-contracts.ts";

export interface SessionPluginsController {
  plugins: readonly DraftSelectablePlugin[] | null;
  enabledPluginIds: string[] | null;
  loading: boolean;
  applying: boolean;
  error?: string;
  /** 运行中会话需确认中止后重试的会话级选择。 */
  pendingAbortSelection: { enabledPluginIds: string[] | null } | null;
  clearError(): void;
  clearPendingAbort(): void;
  reload(): Promise<void>;
  apply(enabledPluginIds: string[] | null): Promise<void>;
  applyConfirmedAbort(): Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 会话级插件选择：读取可选插件与当前子集，变更时经 main 替换 worker 加载集。 */
export function useSessionPlugins(projectId: string, threadId: string): SessionPluginsController {
  const [plugins, setPlugins] = useState<readonly DraftSelectablePlugin[] | null>(null);
  const [enabledPluginIds, setEnabledPluginIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingAbortSelection, setPendingAbortSelection] =
    useState<SessionPluginsController["pendingAbortSelection"]>(null);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const applyInFlight = useRef(false);
  const scopeKey = JSON.stringify([projectId, threadId]);
  const currentScopeKey = useRef(scopeKey);

  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.desktop.extensions.getSessionPlugins(projectId, threadId);
      if (mounted.current && scopeKey === currentScopeKey.current && generation === requestGeneration.current) {
        setPlugins(next.plugins);
        setEnabledPluginIds(next.enabledPluginIds);
      }
    } catch (reason) {
      if (mounted.current && scopeKey === currentScopeKey.current && generation === requestGeneration.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (mounted.current && scopeKey === currentScopeKey.current && generation === requestGeneration.current) {
        setLoading(false);
      }
    }
  }, [projectId, scopeKey, threadId]);
  const reloadRef = useRef(reload);

  useLayoutEffect(() => {
    currentScopeKey.current = scopeKey;
    reloadRef.current = reload;
  }, [reload, scopeKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = useCallback(
    async (selection: string[] | null) => {
      if (applyInFlight.current) return;
      const operationScopeKey = currentScopeKey.current;
      applyInFlight.current = true;
      setApplying(true);
      setError(undefined);
      setPendingAbortSelection(null);
      try {
        await window.desktop.extensions.applySessionPlugins({ projectId, threadId, enabledPluginIds: selection });
        await reloadRef.current();
      } catch (reason) {
        const message = errorMessage(reason);
        if (mounted.current && operationScopeKey === currentScopeKey.current) {
          if (message.includes("confirm abort")) {
            setPendingAbortSelection({ enabledPluginIds: selection });
          } else {
            setError(message);
          }
        }
      } finally {
        applyInFlight.current = false;
        if (mounted.current) setApplying(false);
      }
    },
    [projectId, threadId],
  );

  const applyConfirmedAbort = useCallback(async () => {
    if (applyInFlight.current) return;
    const operationScopeKey = currentScopeKey.current;
    const selection = pendingAbortSelection?.enabledPluginIds ?? null;
    applyInFlight.current = true;
    setApplying(true);
    setError(undefined);
    setPendingAbortSelection(null);
    try {
      await window.desktop.extensions.applySessionPlugins({
        projectId,
        threadId,
        enabledPluginIds: selection,
        abortRunning: true,
      });
      await reloadRef.current();
    } catch (reason) {
      if (mounted.current && operationScopeKey === currentScopeKey.current) setError(errorMessage(reason));
    } finally {
      applyInFlight.current = false;
      if (mounted.current) setApplying(false);
    }
  }, [pendingAbortSelection, projectId, threadId]);

  const clearError = useCallback(() => setError(undefined), []);
  const clearPendingAbort = useCallback(() => setPendingAbortSelection(null), []);

  return {
    plugins,
    enabledPluginIds,
    loading,
    applying,
    error,
    pendingAbortSelection,
    clearError,
    clearPendingAbort,
    reload,
    apply,
    applyConfirmedAbort,
  };
}
