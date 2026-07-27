import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopExtensionSettingsMutation,
  DesktopExtensionSettingsSnapshot,
} from "../../../../shared/desktop-extension-contracts.ts";

export interface LocalPluginsController {
  snapshot?: DesktopExtensionSettingsSnapshot;
  loading: boolean;
  mutating: boolean;
  error?: string;
  clearError(): void;
  reload(): Promise<void>;
  mutate(mutation: DesktopExtensionSettingsMutation): Promise<void>;
  chooseDevelopmentEntry(): Promise<void>;
}

export function useLocalPlugins(projectId?: string, threadId?: string): LocalPluginsController {
  const [snapshot, setSnapshot] = useState<DesktopExtensionSettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const mutationInFlight = useRef(false);
  const scopeKey = JSON.stringify([projectId ?? null, threadId ?? null]);
  const currentScopeKey = useRef(scopeKey);

  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.desktop.extensions.getConfig(projectId, threadId);
      if (mounted.current && scopeKey === currentScopeKey.current && generation === requestGeneration.current) {
        setSnapshot(next);
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

  const mutate = useCallback(
    async (mutation: DesktopExtensionSettingsMutation) => {
      if (!snapshot || mutationInFlight.current) return;
      const operationScopeKey = currentScopeKey.current;
      mutationInFlight.current = true;
      setMutating(true);
      setError(undefined);
      try {
        const result = await window.desktop.extensions.saveConfig({
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          mutation,
        });
        await reloadRef.current();
        if (result.status === "conflict" && mounted.current && operationScopeKey === currentScopeKey.current) {
          setError("本地插件设置已在其他窗口中更新，请重新操作。");
        }
      } catch (reason) {
        if (mounted.current && operationScopeKey === currentScopeKey.current) setError(errorMessage(reason));
      } finally {
        mutationInFlight.current = false;
        if (mounted.current) setMutating(false);
      }
    },
    [snapshot],
  );

  const chooseDevelopmentEntry = useCallback(async () => {
    if (!snapshot || mutationInFlight.current) return;
    const operationScopeKey = currentScopeKey.current;
    mutationInFlight.current = true;
    setMutating(true);
    setError(undefined);
    try {
      const result = await window.desktop.extensions.chooseDevelopmentEntry({
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
      });
      await reloadRef.current();
      if (result.status === "conflict" && mounted.current && operationScopeKey === currentScopeKey.current) {
        setError("本地插件设置已在其他窗口中更新，请重新添加。");
      }
    } catch (reason) {
      if (mounted.current && operationScopeKey === currentScopeKey.current) setError(errorMessage(reason));
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setMutating(false);
    }
  }, [snapshot]);

  return {
    snapshot,
    loading,
    mutating,
    error,
    clearError: () => setError(undefined),
    reload,
    mutate,
    chooseDevelopmentEntry,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
