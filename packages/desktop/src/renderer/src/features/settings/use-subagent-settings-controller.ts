import { useCallback, useEffect, useRef, useState } from "react";
import type { SubagentSettingsMutation, SubagentSettingsSnapshot } from "../../../../shared/subagent-contracts.ts";

export interface SubagentSettingsController {
  snapshot?: SubagentSettingsSnapshot;
  loading: boolean;
  mutating: boolean;
  error?: string;
  reload(): Promise<void>;
  mutate(mutation: SubagentSettingsMutation): Promise<boolean>;
}

export function useSubagentSettingsController(projectId?: string): SubagentSettingsController {
  const [snapshot, setSnapshot] = useState<SubagentSettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.desktop.subagents.getSnapshot({ projectId });
      if (mounted.current) setSnapshot(next);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const mutate = useCallback(
    async (mutation: SubagentSettingsMutation): Promise<boolean> => {
      if (!snapshot || mutating) return false;
      setMutating(true);
      setError(undefined);
      try {
        const result = await window.desktop.subagents.saveConfig({
          requestId: crypto.randomUUID(),
          projectId,
          expectedSnapshotRevision: snapshot.revision,
          mutation,
        });
        if (!mounted.current) return false;
        if (result.status === "conflict") {
          setSnapshot(result.current);
          setError("子智能体配置已在外部更新，请重新操作。");
          return false;
        }
        setSnapshot(result.snapshot);
        return true;
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
        return false;
      } finally {
        if (mounted.current) setMutating(false);
      }
    },
    [mutating, projectId, snapshot],
  );

  return { snapshot, loading, mutating, error, reload, mutate };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
