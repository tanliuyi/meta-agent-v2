import { errorMessage } from "@renderer/shared/lib/error-message";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutoTitleModelOption,
  AutoTitleSettings,
  AutoTitleSettingsSnapshot,
} from "../../../../../shared/auto-title-contracts.ts";
import { validateAutoTitleSettings } from "../../../../../shared/auto-title-contracts.ts";

export type AutoTitleSettingsStatus = "loading" | "ready" | "dirty" | "saving" | "saved" | "conflict" | "error";

export interface AutoTitleSettingsController {
  status: AutoTitleSettingsStatus;
  snapshot?: AutoTitleSettingsSnapshot;
  draft?: AutoTitleSettings;
  modelOptions: AutoTitleModelOption[];
  dirty: boolean;
  errors: string[];
  error?: string;
  notice?: string;
  routeBlocked: boolean;
  mutateSettings(change: Partial<AutoTitleSettings>): void;
  save(): Promise<void>;
  reload(): Promise<void>;
  discardAndProceed(): void;
  cancelRouteChange(): void;
}

function settingsEqual(left: AutoTitleSettings, right: AutoTitleSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.systemPrompt === right.systemPrompt &&
    left.maxLength === right.maxLength
  );
}

export function useAutoTitleSettingsController(): AutoTitleSettingsController {
  const [snapshot, setSnapshot] = useState<AutoTitleSettingsSnapshot>();
  const [draft, setDraft] = useState<AutoTitleSettings>();
  const [modelOptions, setModelOptions] = useState<AutoTitleModelOption[]>([]);
  const [status, setStatus] = useState<AutoTitleSettingsStatus>("loading");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const snapshotRef = useRef<AutoTitleSettingsSnapshot | undefined>(undefined);
  const draftRef = useRef<AutoTitleSettings | undefined>(undefined);
  const dirtyRef = useRef(false);
  const busy = useRef(false);

  const dirty = Boolean(snapshot && draft && !settingsEqual(snapshot.settings, draft));
  const errors = useMemo(() => (draft ? validateAutoTitleSettings(draft) : []), [draft]);
  const routeBlocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: false });

  const setEditorDirty = useCallback((nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    window.desktop.autoTitle.setEditorDirty(nextDirty);
  }, []);

  const replaceSnapshot = useCallback(
    (next: AutoTitleSettingsSnapshot, nextStatus: AutoTitleSettingsStatus = "ready") => {
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
      const [nextSnapshot, nextModelOptions] = await Promise.all([
        window.desktop.autoTitle.getSnapshot(),
        window.desktop.autoTitle.getModelOptions().catch(() => []),
      ]);
      setModelOptions(nextModelOptions);
      replaceSnapshot(nextSnapshot);
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
    (change: Partial<AutoTitleSettings>) => {
      if (busy.current || !draftRef.current) return;
      const next = { ...draftRef.current, ...change };
      draftRef.current = next;
      setDraft(next);
      setNotice(undefined);
      setError(undefined);
      const nextDirty = Boolean(snapshotRef.current && !settingsEqual(snapshotRef.current.settings, next));
      setEditorDirty(nextDirty);
      setStatus(nextDirty ? "dirty" : "ready");
    },
    [setEditorDirty],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const settings = draftRef.current;
    if (!currentSnapshot || !settings || busy.current || settingsEqual(currentSnapshot.settings, settings)) return;
    if (validateAutoTitleSettings(settings).length > 0) return;
    busy.current = true;
    setStatus("saving");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.desktop.autoTitle.saveConfig({
        expectedRevision: currentSnapshot.revision,
        settings: structuredClone(settings),
      });
      if (result.status === "conflict") {
        setError("配置文件已被其他进程修改，请重新载入后再保存。");
        setStatus("conflict");
      } else {
        replaceSnapshot(result.snapshot, "saved");
        setNotice("自动标题设置已保存，新会话立即生效。");
      }
    } catch (value) {
      if (!mounted.current) return;
      setError(errorMessage(value));
      setStatus("error");
    } finally {
      busy.current = false;
    }
  }, [replaceSnapshot]);

  return {
    status,
    snapshot,
    draft,
    modelOptions,
    dirty,
    errors,
    error,
    notice,
    routeBlocked: routeBlocker.status === "blocked",
    mutateSettings,
    save,
    reload: load,
    discardAndProceed: () => {
      setEditorDirty(false);
      routeBlocker.proceed?.();
    },
    cancelRouteChange: () => routeBlocker.reset?.(),
  };
}
