import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplyDesktopExtensionSetResult,
  DesktopExtensionSettingsMutation,
  DesktopExtensionSettingsSnapshot,
} from "../../../../shared/desktop-extension-contracts.ts";

export interface ExtensionsSettingsController {
  snapshot?: DesktopExtensionSettingsSnapshot;
  loading: boolean;
  mutating: boolean;
  error?: string;
  applyResult?: ApplyDesktopExtensionSetResult;
  reload(): Promise<void>;
  mutate(mutation: DesktopExtensionSettingsMutation): Promise<void>;
  chooseDevelopmentEntry(): Promise<void>;
  apply(projectId: string, threadId: string, abortRunning: boolean): Promise<void>;
}

export function useExtensionsSettingsController(projectId?: string, threadId?: string): ExtensionsSettingsController {
  const [snapshot, setSnapshot] = useState<DesktopExtensionSettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const [applyResult, setApplyResult] = useState<ApplyDesktopExtensionSetResult>();
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.desktop.extensions.getConfig(projectId, threadId);
      if (mounted.current) setSnapshot(next);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId, threadId]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const mutate = useCallback(
    async (mutation: DesktopExtensionSettingsMutation) => {
      if (!snapshot || mutating) return;
      setMutating(true);
      setError(undefined);
      setApplyResult(undefined);
      try {
        const result = await window.desktop.extensions.saveConfig({
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          mutation,
        });
        if (result.status === "conflict") {
          setError("扩展设置已在其他窗口中更新，请重新操作。");
        }
        await reload();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setMutating(false);
      }
    },
    [mutating, reload, snapshot],
  );

  const chooseDevelopmentEntry = useCallback(async () => {
    if (!snapshot || mutating) return;
    setMutating(true);
    setError(undefined);
    setApplyResult(undefined);
    try {
      const result = await window.desktop.extensions.chooseDevelopmentEntry({
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
      });
      if (result.status === "conflict") setError("扩展设置已在其他窗口中更新，请重新添加。");
      await reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setMutating(false);
    }
  }, [mutating, reload, snapshot]);

  const apply = useCallback(
    async (projectId: string, threadId: string, abortRunning: boolean) => {
      if (mutating || !snapshot?.desiredGeneration) return;
      setMutating(true);
      setError(undefined);
      setApplyResult(undefined);
      try {
        const result = await window.desktop.extensions.apply({
          projectId,
          threadId,
          expectedDesiredGeneration: snapshot.desiredGeneration,
          abortRunning,
        });
        setApplyResult(result);
        await reload();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setMutating(false);
      }
    },
    [mutating, reload, snapshot?.desiredGeneration],
  );

  return { snapshot, loading, mutating, error, applyResult, reload, mutate, chooseDevelopmentEntry, apply };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
