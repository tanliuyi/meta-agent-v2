import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SubagentSettingsMutation,
  SubagentSettingsSnapshot,
  SubagentSettingsTarget,
} from "../../../../../shared/subagent-contracts.ts";

export interface SubagentSettingsController {
  snapshot?: SubagentSettingsSnapshot;
  loading: boolean;
  mutating: boolean;
  error?: string;
  reload(): Promise<void>;
  mutate(mutation: SubagentSettingsMutation): Promise<boolean>;
}

type SettingsScope = "user" | "project" | "system";
type TargetedSnapshot = { targetKey: string; snapshot: SubagentSettingsSnapshot };
type TargetedError = { targetKey: string; message: string };

export function useSubagentSettingsController(
  projectId?: string,
  settingsScope: SettingsScope = "user",
): SubagentSettingsController {
  const targetKey = subagentSettingsTargetKey(projectId, settingsScope);
  const [snapshotState, setSnapshotState] = useState<TargetedSnapshot>();
  const [loadingTargetKey, setLoadingTargetKey] = useState<string | undefined>(targetKey);
  const [mutatingTargetKey, setMutatingTargetKey] = useState<string>();
  const [errorState, setErrorState] = useState<TargetedError>();
  const mounted = useRef(true);
  const contextGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const snapshot = subagentSettingsSnapshotForTarget(snapshotState, targetKey);
  const error = errorState?.targetKey === targetKey ? errorState.message : undefined;
  const loading = loadingTargetKey === targetKey || (snapshot === undefined && error === undefined);
  const mutating = mutatingTargetKey === targetKey;

  const reload = useCallback(async () => {
    const request = ++requestGeneration.current;
    const requestTargetKey = subagentSettingsTargetKey(projectId, settingsScope);
    setLoadingTargetKey(requestTargetKey);
    setErrorState(undefined);
    try {
      const next = await window.desktop.subagents.getSnapshot(settingsTarget(projectId, settingsScope));
      if (mounted.current && request === requestGeneration.current) {
        setSnapshotState({ targetKey: requestTargetKey, snapshot: next });
      }
    } catch (reason) {
      if (mounted.current && request === requestGeneration.current) {
        setErrorState({ targetKey: requestTargetKey, message: errorMessage(reason) });
      }
    } finally {
      if (mounted.current && request === requestGeneration.current) {
        setLoadingTargetKey((current) => (current === requestTargetKey ? undefined : current));
      }
    }
  }, [projectId, settingsScope]);

  useEffect(() => {
    mounted.current = true;
    contextGeneration.current += 1;
    requestGeneration.current += 1;
    setMutatingTargetKey(undefined);
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const mutate = useCallback(
    async (mutation: SubagentSettingsMutation): Promise<boolean> => {
      if (!snapshot || mutating) return false;
      const generation = contextGeneration.current;
      const mutationTargetKey = subagentSettingsTargetKey(projectId, settingsScope);
      requestGeneration.current += 1;
      setLoadingTargetKey(undefined);
      setMutatingTargetKey(mutationTargetKey);
      setErrorState(undefined);
      try {
        const result = await window.desktop.subagents.saveConfig({
          requestId: crypto.randomUUID(),
          ...settingsTarget(projectId, settingsScope),
          expectedSnapshotRevision: snapshot.revision,
          mutation,
        });
        if (!mounted.current || generation !== contextGeneration.current) return false;
        if (result.status === "conflict") {
          setSnapshotState({ targetKey: mutationTargetKey, snapshot: result.current });
          setErrorState({ targetKey: mutationTargetKey, message: "子智能体配置已在外部更新，请重新操作。" });
          return false;
        }
        setSnapshotState({ targetKey: mutationTargetKey, snapshot: result.snapshot });
        return true;
      } catch (reason) {
        if (mounted.current && generation === contextGeneration.current) {
          setErrorState({ targetKey: mutationTargetKey, message: errorMessage(reason) });
        }
        return false;
      } finally {
        if (mounted.current && generation === contextGeneration.current) {
          setMutatingTargetKey((current) => (current === mutationTargetKey ? undefined : current));
        }
      }
    },
    [mutating, projectId, settingsScope, snapshot],
  );

  return { snapshot, loading, mutating, error, reload, mutate };
}

export function resolveSubagentSettingsActiveTab(
  selectedTab: string,
  projects: readonly { id: string; available: boolean }[],
): string {
  if (!selectedTab.startsWith("project:")) return selectedTab;
  const projectId = selectedTab.slice("project:".length);
  return projects.some((project) => project.id === projectId && project.available) ? selectedTab : "user";
}

export function subagentSettingsSnapshotForTarget(
  state: TargetedSnapshot | undefined,
  targetKey: string,
): SubagentSettingsSnapshot | undefined {
  return state?.targetKey === targetKey ? state.snapshot : undefined;
}

export function subagentSettingsTargetKey(projectId: string | undefined, settingsScope: SettingsScope): string {
  return projectId ? `project:${projectId}` : settingsScope === "system" ? "system" : "user";
}

function settingsTarget(projectId: string | undefined, settingsScope: SettingsScope): SubagentSettingsTarget {
  if (projectId) return { settingsScope: "project", projectId };
  return { settingsScope: settingsScope === "system" ? "system" : "user" };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
