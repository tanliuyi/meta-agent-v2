import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelsConfigDiagnostic,
  ModelsConfigSnapshot,
  ModelsProviderDraft,
  SaveModelsConfigResult,
} from "../../../../shared/models-config-contracts.ts";
import { cloneModelsProviders, modelsDraftsEqual, validateModelsDraft } from "./models-settings-model.ts";

export type ModelsSettingsStatus =
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

interface PendingConfirmation {
  message: string;
  token: string;
  expectedRevision: string;
  providers: ModelsProviderDraft[];
}

export interface ModelsSettingsController {
  status: ModelsSettingsStatus;
  snapshot?: ModelsConfigSnapshot;
  draft: ModelsProviderDraft[];
  diagnostics: ModelsConfigDiagnostic[];
  dirty: boolean;
  error?: string;
  externallyChanged: boolean;
  pendingConfirmation?: PendingConfirmation;
  routeBlocked: boolean;
  selectedProviderIndex?: number;
  selectProvider(index: number | undefined): void;
  mutate(mutator: (providers: ModelsProviderDraft[]) => void): void;
  save(): Promise<void>;
  confirmSave(): Promise<void>;
  cancelSaveConfirmation(): void;
  reload(): Promise<void>;
  discardAndProceed(): void;
  cancelRouteChange(): void;
  openExternally(): Promise<void>;
}

export function useModelsSettingsController(): ModelsSettingsController {
  const [snapshot, setSnapshot] = useState<ModelsConfigSnapshot>();
  const [draft, setDraft] = useState<ModelsProviderDraft[]>([]);
  const [status, setStatus] = useState<ModelsSettingsStatus>("loading");
  const [serverDiagnostics, setServerDiagnostics] = useState<ModelsConfigDiagnostic[]>([]);
  const [error, setError] = useState<string>();
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const [selectedProviderIndex, setSelectedProviderIndex] = useState<number>();
  const snapshotRef = useRef<ModelsConfigSnapshot | undefined>(undefined);
  const draftRef = useRef<ModelsProviderDraft[]>([]);
  const dirtyRef = useRef(false);
  const pageGeneration = useRef(0);
  const draftGeneration = useRef(0);
  const revisionRequest = useRef<Promise<string> | undefined>(undefined);
  const saving = useRef(false);
  const mounted = useRef(true);

  const diagnostics = useMemo(() => [...serverDiagnostics, ...validateModelsDraft(draft)], [draft, serverDiagnostics]);
  const dirty = snapshot ? !modelsDraftsEqual(draft, snapshot.providers) : false;
  const routeBlocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: false,
  });

  const replaceSnapshot = useCallback((next: ModelsConfigSnapshot, nextStatus?: ModelsSettingsStatus) => {
    snapshotRef.current = next;
    const providers = cloneModelsProviders(next.providers);
    draftRef.current = providers;
    dirtyRef.current = false;
    draftGeneration.current += 1;
    pageGeneration.current += 1;
    window.desktop.models.setEditorDirty(false);
    setSnapshot(next);
    setDraft(providers);
    setServerDiagnostics(next.diagnostics);
    setExternallyChanged(false);
    setError(undefined);
    setSelectedProviderIndex((current) =>
      current !== undefined && current < providers.length ? current : providers.length > 0 ? 0 : undefined,
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
      const next = await window.desktop.models.getConfig();
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
      window.desktop.models.setEditorDirty(false);
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
      revisionRequest.current ??= window.desktop.models.getConfigRevision().finally(() => {
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
        const next = await window.desktop.models.getConfig();
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

  const mutate = useCallback((mutator: (providers: ModelsProviderDraft[]) => void) => {
    if (saving.current) return;
    const next = cloneModelsProviders(draftRef.current);
    mutator(next);
    draftRef.current = next;
    draftGeneration.current += 1;
    const baseline = snapshotRef.current?.providers ?? [];
    const nextDirty = !modelsDraftsEqual(next, baseline);
    if (nextDirty !== dirtyRef.current) {
      window.desktop.models.setEditorDirty(nextDirty);
      dirtyRef.current = nextDirty;
    }
    setServerDiagnostics([]);
    setExternallyChanged(false);
    setDraft(next);
    const localDiagnostics = validateModelsDraft(next);
    setStatus(nextDirty ? (localDiagnostics.length > 0 ? "ready-dirty-invalid" : "ready-dirty-valid") : "ready-clean");
  }, []);

  const handleSaveResult = useCallback(
    (result: SaveModelsConfigResult, submitted: PendingConfirmation | undefined) => {
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
      setPendingConfirmation({
        message: result.message,
        token: result.confirmationToken,
        expectedRevision: submitted?.expectedRevision ?? snapshotRef.current?.revision ?? "",
        providers: submitted?.providers ?? cloneModelsProviders(draftRef.current),
      });
      setStatus("ready-dirty-valid");
    },
    [replaceSnapshot],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const providers = cloneModelsProviders(draftRef.current);
    if (!currentSnapshot || validateModelsDraft(providers).length > 0 || !dirtyRef.current || saving.current) return;
    saving.current = true;
    const submitted: PendingConfirmation = {
      message: "",
      token: "",
      expectedRevision: currentSnapshot.revision,
      providers,
    };
    setStatus("saving");
    setError(undefined);
    try {
      const result = await window.desktop.models.saveConfig({
        expectedRevision: submitted.expectedRevision,
        providers: submitted.providers,
      });
      handleSaveResult(result, submitted);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setStatus("write-error");
    } finally {
      saving.current = false;
    }
  }, [handleSaveResult]);

  const confirmSave = useCallback(async () => {
    const pending = pendingConfirmation;
    if (!pending || saving.current) return;
    saving.current = true;
    setPendingConfirmation(undefined);
    setStatus("saving");
    try {
      const result = await window.desktop.models.saveConfig({
        expectedRevision: pending.expectedRevision,
        providers: pending.providers,
        confirmationToken: pending.token,
      });
      handleSaveResult(result, pending);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setStatus("write-error");
    } finally {
      saving.current = false;
    }
  }, [handleSaveResult, pendingConfirmation]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const discardAndProceed = useCallback(() => {
    dirtyRef.current = false;
    window.desktop.models.setEditorDirty(false);
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
    pendingConfirmation,
    routeBlocked: routeBlocker.status === "blocked",
    selectedProviderIndex,
    selectProvider: setSelectedProviderIndex,
    mutate,
    save,
    confirmSave,
    cancelSaveConfirmation: () => setPendingConfirmation(undefined),
    reload,
    discardAndProceed,
    cancelRouteChange: () => routeBlocker.reset?.(),
    openExternally: () => window.desktop.models.openConfigExternally(),
  };
}

function isDocumentHidden(): boolean {
  return document.visibilityState === "hidden";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
