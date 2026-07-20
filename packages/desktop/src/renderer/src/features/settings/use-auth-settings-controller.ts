import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthConfigDiagnostic,
  AuthConfigSnapshot,
  AuthProviderDraft,
  SaveAuthConfigResult,
} from "../../../../shared/auth-config-contracts.ts";
import { authDraftsEqual, cloneAuthProviders, validateAuthDraft } from "./auth-settings-model.ts";

export type AuthSettingsStatus =
  | "loading"
  | "missing"
  | "ready-clean"
  | "ready-dirty-valid"
  | "ready-dirty-invalid"
  | "source-invalid"
  | "saving"
  | "saved"
  | "conflict"
  | "read-error"
  | "write-error";

export interface AuthSettingsController {
  status: AuthSettingsStatus;
  snapshot?: AuthConfigSnapshot;
  draft: AuthProviderDraft[];
  diagnostics: AuthConfigDiagnostic[];
  dirty: boolean;
  error?: string;
  externallyChanged: boolean;
  routeBlocked: boolean;
  selectedKey?: string;
  selectProvider(key: string | undefined): void;
  mutate(mutator: (providers: AuthProviderDraft[]) => void): void;
  save(): Promise<void>;
  reload(): Promise<void>;
  discardAndProceed(): void;
  cancelRouteChange(): void;
  openExternally(): Promise<void>;
}

export function useAuthSettingsController(): AuthSettingsController {
  const [snapshot, setSnapshot] = useState<AuthConfigSnapshot>();
  const [draft, setDraft] = useState<AuthProviderDraft[]>([]);
  const [status, setStatus] = useState<AuthSettingsStatus>("loading");
  const [serverDiagnostics, setServerDiagnostics] = useState<AuthConfigDiagnostic[]>([]);
  const [error, setError] = useState<string>();
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>();
  const snapshotRef = useRef<AuthConfigSnapshot | undefined>(undefined);
  const draftRef = useRef<AuthProviderDraft[]>([]);
  const dirtyRef = useRef(false);
  const pageGeneration = useRef(0);
  const draftGeneration = useRef(0);
  const revisionRequest = useRef<Promise<string> | undefined>(undefined);
  const saving = useRef(false);
  const mounted = useRef(true);

  const diagnostics = useMemo(() => [...serverDiagnostics, ...validateAuthDraft(draft)], [draft, serverDiagnostics]);
  const dirty = snapshot ? !authDraftsEqual(draft, snapshot.providers) : false;
  const routeBlocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: false,
  });

  const replaceSnapshot = useCallback((next: AuthConfigSnapshot, nextStatus?: AuthSettingsStatus) => {
    snapshotRef.current = next;
    const providers = cloneAuthProviders(next.providers);
    draftRef.current = providers;
    dirtyRef.current = false;
    draftGeneration.current += 1;
    pageGeneration.current += 1;
    window.desktop.auth.setEditorDirty(false);
    setSnapshot(next);
    setDraft(providers);
    setServerDiagnostics(next.diagnostics);
    setExternallyChanged(false);
    setError(undefined);
    setSelectedKey((current) =>
      current !== undefined && providers.some((p) => p.key === current)
        ? current
        : providers.length > 0
          ? providers[0]!.key
          : undefined,
    );
    setStatus(
      nextStatus ??
        (next.sourceState === "invalid"
          ? "source-invalid"
          : next.sourceState === "missing"
            ? "missing"
            : "ready-clean"),
    );
  }, []);

  const load = useCallback(async () => {
    const generation = ++pageGeneration.current;
    setStatus("loading");
    setError(undefined);
    try {
      const next = await window.desktop.auth.getConfig();
      if (!mounted.current || generation !== pageGeneration.current) return;
      replaceSnapshot(next);
    } catch (loadError) {
      if (!mounted.current || generation !== pageGeneration.current) return;
      setError(errorMessage(loadError));
      setStatus("read-error");
    }
  }, [replaceSnapshot]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      pageGeneration.current += 1;
      draftGeneration.current += 1;
      dirtyRef.current = false;
      window.desktop.auth.setEditorDirty(false);
    };
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async () => {
      if (stopped || isDocumentHidden() || !snapshotRef.current) return;
      const capturedPage = pageGeneration.current;
      const capturedDraft = draftGeneration.current;
      const capturedRevision = snapshotRef.current.revision;
      revisionRequest.current ??= window.desktop.auth.getConfigRevision().finally(() => {
        revisionRequest.current = undefined;
      });
      try {
        const revision = await revisionRequest.current;
        if (
          stopped ||
          !mounted.current ||
          isDocumentHidden() ||
          capturedPage !== pageGeneration.current ||
          capturedDraft !== draftGeneration.current ||
          capturedRevision !== snapshotRef.current?.revision ||
          revision === capturedRevision
        ) {
          return;
        }
        if (dirtyRef.current) {
          setExternallyChanged(true);
          setStatus("conflict");
          return;
        }
        const next = await window.desktop.auth.getConfig();
        if (
          stopped ||
          capturedPage !== pageGeneration.current ||
          capturedDraft !== draftGeneration.current ||
          capturedRevision !== snapshotRef.current?.revision
        ) {
          return;
        }
        replaceSnapshot(next);
      } catch {
        // Save and explicit reload surface I/O failures; polling remains non-disruptive.
      } finally {
        if (!stopped && !isDocumentHidden()) timer = setTimeout(check, 5_000);
      }
    };
    const onFocus = () => void check();
    const onVisibility = () => {
      pageGeneration.current += 1;
      if (!isDocumentHidden()) void check();
    };
    timer = setTimeout(check, 5_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [replaceSnapshot]);

  const mutate = useCallback((mutator: (providers: AuthProviderDraft[]) => void) => {
    if (saving.current) return;
    const next = cloneAuthProviders(draftRef.current);
    mutator(next);
    draftRef.current = next;
    draftGeneration.current += 1;
    const baseline = snapshotRef.current?.providers ?? [];
    const nextDirty = !authDraftsEqual(next, baseline);
    if (nextDirty !== dirtyRef.current) {
      window.desktop.auth.setEditorDirty(nextDirty);
      dirtyRef.current = nextDirty;
    }
    setServerDiagnostics([]);
    setExternallyChanged(false);
    setDraft(next);
    const localDiagnostics = validateAuthDraft(next);
    setStatus(nextDirty ? (localDiagnostics.length > 0 ? "ready-dirty-invalid" : "ready-dirty-valid") : "ready-clean");
  }, []);

  const handleSaveResult = useCallback(
    (result: SaveAuthConfigResult) => {
      if (result.status === "saved") {
        replaceSnapshot(result.snapshot, "saved");
        return;
      }
      if (result.status === "invalid") {
        setServerDiagnostics(result.diagnostics);
        setStatus("ready-dirty-invalid");
        return;
      }
      if (result.status === "conflict") {
        setExternallyChanged(true);
        setStatus("conflict");
        return;
      }
    },
    [replaceSnapshot],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const providers = cloneAuthProviders(draftRef.current);
    if (!currentSnapshot || validateAuthDraft(providers).length > 0 || !dirtyRef.current || saving.current) return;
    saving.current = true;
    const expectedRevision = currentSnapshot.revision;
    setStatus("saving");
    setError(undefined);
    try {
      const result = await window.desktop.auth.saveConfig({
        expectedRevision,
        providers,
      });
      handleSaveResult(result);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setStatus("write-error");
    } finally {
      saving.current = false;
    }
  }, [handleSaveResult]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const discardAndProceed = useCallback(() => {
    dirtyRef.current = false;
    window.desktop.auth.setEditorDirty(false);
    routeBlocker.proceed?.();
  }, [routeBlocker]);

  return {
    status,
    snapshot,
    draft,
    diagnostics,
    dirty,
    error,
    externallyChanged,
    routeBlocked: routeBlocker.status === "blocked",
    selectedKey,
    selectProvider: setSelectedKey,
    mutate,
    save,
    reload,
    discardAndProceed,
    cancelRouteChange: () => routeBlocker.reset?.(),
    openExternally: () => window.desktop.auth.openConfigExternally(),
  };
}

function isDocumentHidden(): boolean {
  return document.visibilityState === "hidden";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
