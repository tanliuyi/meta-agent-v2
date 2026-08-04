import { errorMessage } from "@renderer/shared/lib/error-message";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryMaintenanceAction,
  MemorySettings,
  MemorySettingsSnapshot,
  MutateMemoryEntryInput,
} from "../../../../../shared/memory-settings-contracts.ts";
import { validateMemorySettings } from "../../../../../shared/memory-settings-contracts.ts";

export type MemorySettingsStatus =
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "working"
  | "error";

export interface MemorySettingsController {
  status: MemorySettingsStatus;
  snapshot?: MemorySettingsSnapshot;
  draft?: MemorySettings;
  dirty: boolean;
  errors: string[];
  error?: string;
  notice?: string;
  activeAction?: MemoryMaintenanceAction;
  routeBlocked: boolean;
  mutateSettings(change: Partial<MemorySettings>): void;
  save(): Promise<void>;
  reload(): Promise<void>;
  mutateEntry(input: Omit<MutateMemoryEntryInput, "expectedRevision">): Promise<boolean>;
  runMaintenance(action: MemoryMaintenanceAction): Promise<void>;
  discardAndProceed(): void;
  cancelRouteChange(): void;
}

export function useMemorySettingsController(): MemorySettingsController {
  const [snapshot, setSnapshot] = useState<MemorySettingsSnapshot>();
  const [draft, setDraft] = useState<MemorySettings>();
  const [status, setStatus] = useState<MemorySettingsStatus>("loading");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [activeAction, setActiveAction] = useState<MemoryMaintenanceAction>();
  const mounted = useRef(true);
  const snapshotRef = useRef<MemorySettingsSnapshot | undefined>(undefined);
  const draftRef = useRef<MemorySettings | undefined>(undefined);
  const dirtyRef = useRef(false);
  const busy = useRef(false);
  const dirty = Boolean(snapshot && draft && !settingsEqual(snapshot.settings, draft));
  const errors = useMemo(() => (draft ? validateMemorySettings(draft) : []), [draft]);
  const routeBlocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: false });

  const setEditorDirty = useCallback((nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    window.desktop.memorySettings.setEditorDirty(nextDirty);
  }, []);

  const replaceSnapshot = useCallback(
    (next: MemorySettingsSnapshot, nextStatus: MemorySettingsStatus = "ready") => {
      if (!mounted.current) return;
      const nextDraft = structuredClone(next.settings);
      snapshotRef.current = next;
      draftRef.current = nextDraft;
      setEditorDirty(false);
      setSnapshot(next);
      setDraft(nextDraft);
      setError(undefined);
      setStatus(nextStatus);
    },
    [setEditorDirty],
  );

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus("loading");
    setError(undefined);
    try {
      replaceSnapshot(await window.desktop.memorySettings.getSnapshot());
    } catch (value) {
      if (!mounted.current) return;
      setError(errorMessage(value));
      setStatus("error");
    } finally {
      busy.current = false;
    }
  }, [replaceSnapshot]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      setEditorDirty(false);
    };
  }, [load, setEditorDirty]);

  const mutateSettings = useCallback(
    (change: Partial<MemorySettings>) => {
      if (busy.current || !draftRef.current) return;
      const next = { ...draftRef.current, ...change };
      draftRef.current = next;
      setDraft(next);
      setNotice(undefined);
      setError(undefined);
      const nextDirty = !settingsEqual(snapshotRef.current?.settings, next);
      setEditorDirty(nextDirty);
      setStatus(nextDirty ? "dirty" : "ready");
    },
    [setEditorDirty],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const settings = draftRef.current;
    if (!currentSnapshot || !settings || busy.current || settingsEqual(currentSnapshot.settings, settings)) return;
    const validationErrors = validateMemorySettings(settings);
    if (validationErrors.length > 0) return;
    busy.current = true;
    setStatus("saving");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.desktop.memorySettings.saveConfig({
        expectedRevision: currentSnapshot.revision,
        settings: structuredClone(settings),
      });
      if (result.status === "conflict") {
        setError("配置文件已被其他进程修改，请重新载入后再保存。");
        setStatus("conflict");
      } else {
        const nextSnapshot = result.snapshot ?? (await window.desktop.memorySettings.getSnapshot());
        replaceSnapshot(nextSnapshot, "saved");
        setNotice(result.warning ?? "记忆设置已保存，活动会话将重新加载扩展配置。");
      }
    } catch (value) {
      if (!mounted.current) return;
      setError(errorMessage(value));
      setStatus("error");
    } finally {
      busy.current = false;
    }
  }, [replaceSnapshot]);

  const mutateEntry = useCallback(
    async (input: Omit<MutateMemoryEntryInput, "expectedRevision">): Promise<boolean> => {
      if (busy.current || !snapshotRef.current || !draftRef.current) return false;
      if (!settingsEqual(snapshotRef.current.settings, draftRef.current)) return false;
      busy.current = true;
      setStatus("working");
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.memorySettings.mutateEntry({
          ...input,
          expectedRevision: snapshotRef.current.revision,
        });
        const nextSnapshot = result.snapshot ?? (await window.desktop.memorySettings.getSnapshot());
        replaceSnapshot(nextSnapshot);
        if (!result.success) {
          setError(result.error ?? "记忆条目更新失败");
          setStatus("error");
          return false;
        }
        setNotice(result.warning ?? result.message ?? "记忆条目已更新。");
        return true;
      } catch (value) {
        if (mounted.current) {
          setError(errorMessage(value));
          setStatus("error");
        }
        return false;
      } finally {
        busy.current = false;
      }
    },
    [replaceSnapshot],
  );

  const runMaintenance = useCallback(
    async (action: MemoryMaintenanceAction) => {
      if (busy.current || !snapshotRef.current || !draftRef.current) return;
      if (!settingsEqual(snapshotRef.current.settings, draftRef.current)) return;
      busy.current = true;
      setActiveAction(action);
      setStatus("working");
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.memorySettings.runMaintenance({ action });
        const nextSnapshot = result.snapshot ?? (await window.desktop.memorySettings.getSnapshot());
        replaceSnapshot(nextSnapshot);
        if (result.success) setNotice(result.message);
        else {
          setError(result.message);
          setStatus("error");
        }
      } catch (value) {
        if (!mounted.current) return;
        setError(errorMessage(value));
        setStatus("error");
      } finally {
        busy.current = false;
        if (mounted.current) setActiveAction(undefined);
      }
    },
    [replaceSnapshot],
  );

  return {
    status,
    snapshot,
    draft,
    dirty,
    errors,
    error,
    notice,
    activeAction,
    routeBlocked: routeBlocker.status === "blocked",
    mutateSettings,
    save,
    reload: load,
    mutateEntry,
    runMaintenance,
    discardAndProceed: () => {
      setEditorDirty(false);
      routeBlocker.proceed?.();
    },
    cancelRouteChange: () => routeBlocker.reset?.(),
  };
}

function settingsEqual(left: MemorySettings | undefined, right: MemorySettings | undefined): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}
