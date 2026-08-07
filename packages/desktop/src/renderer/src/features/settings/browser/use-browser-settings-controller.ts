import { errorMessage } from "@renderer/shared/lib/error-message";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserSettings, BrowserSettingsSnapshot } from "../../../../../shared/browser-settings-contracts.ts";
import { validateBrowserSettings } from "../../../../../shared/browser-settings-contracts.ts";
import { parseSiteListInput } from "../../../../../shared/browser-site-policy.ts";

export type BrowserSettingsStatus = "loading" | "ready" | "dirty" | "saving" | "saved" | "conflict" | "error";

export interface BrowserSettingsController {
  status: BrowserSettingsStatus;
  snapshot?: BrowserSettingsSnapshot;
  draft?: BrowserSettings;
  dirty: boolean;
  errors: string[];
  error?: string;
  notice?: string;
  routeBlocked: boolean;
  mutateSettings(change: Partial<BrowserSettings>): void;
  setSiteList(field: "allowSites" | "blockSites", raw: string): void;
  save(): Promise<void>;
  reload(): Promise<void>;
  clearData(): Promise<void>;
  discardAndProceed(): void;
  cancelRouteChange(): void;
}

function settingsEqual(left: BrowserSettings, right: BrowserSettings): boolean {
  return (
    JSON.stringify(left.allowSites) === JSON.stringify(right.allowSites) &&
    JSON.stringify(left.blockSites) === JSON.stringify(right.blockSites) &&
    left.downloadDirectory === right.downloadDirectory &&
    left.maxSnapshotNodes === right.maxSnapshotNodes &&
    left.cdpTimeoutMs === right.cdpTimeoutMs &&
    left.restoreTabsOnLaunch === right.restoreTabsOnLaunch &&
    left.confirmSensitiveActions === right.confirmSensitiveActions
  );
}

export function useBrowserSettingsController(): BrowserSettingsController {
  const [snapshot, setSnapshot] = useState<BrowserSettingsSnapshot>();
  const [draft, setDraft] = useState<BrowserSettings>();
  const [status, setStatus] = useState<BrowserSettingsStatus>("loading");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const snapshotRef = useRef<BrowserSettingsSnapshot | undefined>(undefined);
  const draftRef = useRef<BrowserSettings | undefined>(undefined);
  const dirtyRef = useRef(false);
  const busy = useRef(false);

  const dirty = Boolean(snapshot && draft && !settingsEqual(snapshot.settings, draft));
  const errors = useMemo(() => (draft ? validateBrowserSettings(draft) : []), [draft]);
  const routeBlocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: false });

  const setEditorDirty = useCallback((nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    window.desktop.browser.setEditorDirty(nextDirty);
  }, []);

  const replaceSnapshot = useCallback(
    (next: BrowserSettingsSnapshot, nextStatus: BrowserSettingsStatus = "ready") => {
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
      const nextSnapshot = await window.desktop.browser.getSettings();
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
    (change: Partial<BrowserSettings>) => {
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

  const setSiteList = useCallback(
    (field: "allowSites" | "blockSites", raw: string) => {
      mutateSettings({ [field]: parseSiteListInput(raw) });
    },
    [mutateSettings],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const settings = draftRef.current;
    if (!currentSnapshot || !settings || busy.current || settingsEqual(currentSnapshot.settings, settings)) return;
    if (validateBrowserSettings(settings).length > 0) return;
    busy.current = true;
    setStatus("saving");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.desktop.browser.saveSettings({
        expectedRevision: currentSnapshot.revision,
        settings: structuredClone(settings),
      });
      if (result.status === "conflict") {
        setError("配置文件已被其他进程修改，请重新载入后再保存。");
        setStatus("conflict");
      } else {
        replaceSnapshot(result.snapshot, "saved");
        setNotice("浏览器设置已保存。");
      }
    } catch (value) {
      if (!mounted.current) return;
      setError(errorMessage(value));
      setStatus("error");
    } finally {
      busy.current = false;
    }
  }, [replaceSnapshot]);

  const clearData = useCallback(async () => {
    try {
      await window.desktop.browser.clearData();
      if (mounted.current) setNotice("已清除浏览器数据（Cookie、缓存与登录态）。");
    } catch (value) {
      if (mounted.current) setError(errorMessage(value));
    }
  }, []);

  return {
    status,
    snapshot,
    draft,
    dirty,
    errors,
    error,
    notice,
    routeBlocked: routeBlocker.status === "blocked",
    mutateSettings,
    setSiteList,
    save,
    reload: load,
    clearData,
    discardAndProceed: () => {
      setEditorDirty(false);
      routeBlocker.proceed?.();
    },
    cancelRouteChange: () => routeBlocker.reset?.(),
  };
}
