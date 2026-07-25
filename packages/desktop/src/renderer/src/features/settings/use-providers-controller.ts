import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthProviderDraft } from "../../../../shared/auth-config-contracts.ts";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import type {
  ProviderDiagnostic,
  ProviderEntry,
  ProvidersSnapshot,
  SaveProvidersResult,
} from "../../../../shared/providers-config-contracts.ts";
import { cloneAuthProviders, validateAuthDraft } from "./auth-settings-model.ts";
import { cloneModelsProviders, validateModelsDraft } from "./models-settings-model.ts";

export type ProvidersSettingsStatus =
  | "loading"
  | "missing"
  | "ready-clean"
  | "ready-dirty-valid"
  | "ready-dirty-invalid"
  | "saving"
  | "saved"
  | "conflict"
  | "read-error"
  | "write-error";

export interface ProvidersSettingsController {
  status: ProvidersSettingsStatus;
  snapshot?: ProvidersSnapshot;
  modelsDraft: ModelsProviderDraft[];
  authDraft: AuthProviderDraft[];
  providers: ProviderEntry[];
  diagnostics: ProviderDiagnostic[];
  dirty: boolean;
  error?: string;
  externallyChanged: boolean;
  pendingConfirmation?: PendingConfirmation;
  routeBlocked: boolean;
  /** Reload from disk (discarding local edits). */
  reload(): Promise<void>;
  /** Save both models.json and auth.json. */
  save(): Promise<void>;
  /** Confirm a JSONC-comment-move warning. */
  confirmSave(): Promise<void>;
  cancelSaveConfirmation(): void;
  discardAndProceed(): void;
  cancelRouteChange(): void;
  openModelsExternally(): Promise<void>;
  openAuthExternally(): Promise<void>;
  /** Currently selected provider key for the edit dialog. */
  selectedProviderKey?: string;
  selectProvider(key: string | undefined): void;
  /** Mutate the underlying providers array (both models + auth drafts). */
  mutate(mutator: (drafts: ProviderDrafts) => void): void;
}

export interface ProviderDrafts {
  modelsProviders: ModelsProviderDraft[];
  authProviders: AuthProviderDraft[];
}

export interface PendingConfirmation {
  message: string;
  token: string;
  expectedModelsRevision: string;
  expectedAuthRevision: string;
  modelsProviders: ModelsProviderDraft[];
  authProviders: AuthProviderDraft[];
}

export function useProvidersSettingsController(): ProvidersSettingsController {
  const [snapshot, setSnapshot] = useState<ProvidersSnapshot>();
  const [modelsDraft, setModelsDraft] = useState<ModelsProviderDraft[]>([]);
  const [authDraft, setAuthDraft] = useState<AuthProviderDraft[]>([]);
  const [serverDiagnostics, setServerDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [status, setStatus] = useState<ProvidersSettingsStatus>("loading");
  const [error, setError] = useState<string>();
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>();
  const snapshotRef = useRef<ProvidersSnapshot | undefined>(undefined);
  const modelsDraftRef = useRef<ModelsProviderDraft[]>([]);
  const authDraftRef = useRef<AuthProviderDraft[]>([]);
  const dirtyRef = useRef(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  const pageGeneration = useRef(0);
  const draftGeneration = useRef(0);
  const revisionRequest = useRef<Promise<{ models: string; auth: string }> | undefined>(undefined);

  const providers: ProviderEntry[] = useMemo(() => {
    if (!snapshot) return [];
    return rebuildProviderEntries(snapshot, modelsDraft, authDraft);
  }, [snapshot, modelsDraft, authDraft]);

  const diagnostics: ProviderDiagnostic[] = useMemo(
    () => [...serverDiagnostics, ...getLocalDiagnostics(modelsDraft, authDraft)],
    [authDraft, modelsDraft, serverDiagnostics],
  );

  const dirty = snapshot
    ? !draftsEqual(modelsDraft, authDraft, snapshot.modelsProviders, snapshot.authProviders)
    : false;

  const routeBlocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: false,
  });

  // ---------------------------------------------------------------------------
  // Snapshot replacement
  // ---------------------------------------------------------------------------
  const replaceSnapshot = useCallback((next: ProvidersSnapshot, nextStatus?: ProvidersSettingsStatus) => {
    snapshotRef.current = next;
    const nextModels = cloneModelsProviders(next.modelsProviders);
    const nextAuth = cloneAuthProviders(next.authProviders);
    modelsDraftRef.current = nextModels;
    authDraftRef.current = nextAuth;
    dirtyRef.current = false;
    draftGeneration.current += 1;
    pageGeneration.current += 1;
    void window.desktop.providers.setEditorDirty(false);
    setSnapshot(next);
    setModelsDraft(nextModels);
    setAuthDraft(nextAuth);
    setServerDiagnostics(next.diagnostics);
    setExternallyChanged(false);
    setError(undefined);
    setStatus(
      nextStatus ??
        (next.modelsSourceState === "invalid" || next.authSourceState === "invalid"
          ? "ready-dirty-invalid"
          : next.modelsSourceState === "missing" && next.authSourceState === "missing"
            ? "missing"
            : "ready-clean"),
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------
  const load = useCallback(async () => {
    const generation = ++pageGeneration.current;
    setStatus("loading");
    setError(undefined);
    try {
      const next = await window.desktop.providers.getConfig();
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
      void window.desktop.providers.setEditorDirty(false);
    };
  }, [load]);

  // ---------------------------------------------------------------------------
  // External change polling
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async () => {
      if (stopped || isDocumentHidden() || !snapshotRef.current) return;
      const capturedPage = pageGeneration.current;
      const capturedDraft = draftGeneration.current;
      const capturedModelsRev = snapshotRef.current.modelsRevision;
      const capturedAuthRev = snapshotRef.current.authRevision;
      revisionRequest.current ??= Promise.all([
        window.desktop.models.getConfigRevision(),
        window.desktop.auth.getConfigRevision(),
      ])
        .then(([models, auth]) => ({ models, auth }))
        .finally(() => {
          revisionRequest.current = undefined;
        });
      try {
        const revisions = await revisionRequest.current;
        if (
          stopped ||
          !mounted.current ||
          isDocumentHidden() ||
          capturedPage !== pageGeneration.current ||
          capturedDraft !== draftGeneration.current
        ) {
          return;
        }
        if (revisions.models === capturedModelsRev && revisions.auth === capturedAuthRev) return;
        if (dirtyRef.current) {
          setExternallyChanged(true);
          setStatus("conflict");
          return;
        }
        const next = await window.desktop.providers.getConfig();
        if (stopped || capturedPage !== pageGeneration.current || capturedDraft !== draftGeneration.current) {
          return;
        }
        replaceSnapshot(next);
      } catch {
        // Non-disruptive polling
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

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------
  const mutate = useCallback((mutator: (drafts: ProviderDrafts) => void) => {
    if (saving.current) return;
    const nextModels = cloneModelsProviders(modelsDraftRef.current);
    const nextAuth = cloneAuthProviders(authDraftRef.current);
    mutator({ modelsProviders: nextModels, authProviders: nextAuth });
    modelsDraftRef.current = nextModels;
    authDraftRef.current = nextAuth;
    draftGeneration.current += 1;
    const baselineModels = snapshotRef.current?.modelsProviders ?? [];
    const baselineAuth = snapshotRef.current?.authProviders ?? [];
    const nextDirty = !modelsDraftsEqual(nextModels, baselineModels) || !authDraftsEqual(nextAuth, baselineAuth);
    if (nextDirty !== dirtyRef.current) {
      void window.desktop.providers.setEditorDirty(nextDirty);
      dirtyRef.current = nextDirty;
    }
    const localDiagnostics = getLocalDiagnostics(nextModels, nextAuth);
    setServerDiagnostics([]);
    setExternallyChanged(false);
    setModelsDraft(nextModels);
    setAuthDraft(nextAuth);
    setStatus(nextDirty ? (localDiagnostics.length > 0 ? "ready-dirty-invalid" : "ready-dirty-valid") : "ready-clean");
  }, []);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const handleSaveResult = useCallback(
    (result: SaveProvidersResult, _submitted: PendingConfirmation | undefined) => {
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
      // confirmation-required
      setPendingConfirmation({
        message: result.message,
        token: result.confirmationToken,
        expectedModelsRevision: result.expectedModelsRevision,
        expectedAuthRevision: result.expectedAuthRevision,
        modelsProviders: result.modelsProviders,
        authProviders: result.authProviders,
      });
      setStatus("ready-dirty-valid");
    },
    [replaceSnapshot],
  );

  const save = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const currentModels = cloneModelsProviders(modelsDraftRef.current);
    const currentAuth = cloneAuthProviders(authDraftRef.current);
    if (
      !currentSnapshot ||
      dirtyRef.current === false ||
      saving.current ||
      getLocalDiagnostics(currentModels, currentAuth).length > 0
    ) {
      return;
    }
    saving.current = true;
    const submitted: PendingConfirmation = {
      message: "",
      token: "",
      expectedModelsRevision: currentSnapshot.modelsRevision,
      expectedAuthRevision: currentSnapshot.authRevision,
      modelsProviders: currentModels,
      authProviders: currentAuth,
    };
    setStatus("saving");
    setError(undefined);
    try {
      const result = await window.desktop.providers.saveConfig({
        expectedModelsRevision: submitted.expectedModelsRevision,
        expectedAuthRevision: submitted.expectedAuthRevision,
        modelsProviders: submitted.modelsProviders,
        authProviders: submitted.authProviders,
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
      const result = await window.desktop.providers.saveConfig({
        expectedModelsRevision: pending.expectedModelsRevision,
        expectedAuthRevision: pending.expectedAuthRevision,
        modelsProviders: pending.modelsProviders,
        authProviders: pending.authProviders,
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
    void window.desktop.providers.setEditorDirty(false);
    routeBlocker.proceed?.();
  }, [routeBlocker]);

  const selectProvider = useCallback((key: string | undefined) => {
    setSelectedProviderKey(key);
  }, []);

  return {
    status,
    snapshot,
    modelsDraft,
    authDraft,
    providers,
    diagnostics,
    dirty,
    error,
    externallyChanged,
    pendingConfirmation,
    routeBlocked: routeBlocker.status === "blocked",
    selectedProviderKey,
    selectProvider,
    reload,
    save,
    confirmSave,
    cancelSaveConfirmation: () => setPendingConfirmation(undefined),
    discardAndProceed,
    cancelRouteChange: () => routeBlocker.reset?.(),
    openModelsExternally: () => window.desktop.models.openConfigExternally(),
    openAuthExternally: () => window.desktop.auth.openConfigExternally(),
    mutate,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDocumentHidden(): boolean {
  return document.visibilityState === "hidden";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelsDraftsEqual(left: ModelsProviderDraft[], right: ModelsProviderDraft[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function authDraftsEqual(left: AuthProviderDraft[], right: AuthProviderDraft[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function draftsEqual(
  leftModels: ModelsProviderDraft[],
  leftAuth: AuthProviderDraft[],
  rightModels: ModelsProviderDraft[],
  rightAuth: AuthProviderDraft[],
): boolean {
  return modelsDraftsEqual(leftModels, rightModels) && authDraftsEqual(leftAuth, rightAuth);
}

function getLocalDiagnostics(
  modelsProviders: ModelsProviderDraft[],
  authProviders: AuthProviderDraft[],
): ProviderDiagnostic[] {
  return [
    ...validateModelsDraft(modelsProviders).map((diagnostic) => ({ ...diagnostic, source: "models" as const })),
    ...validateAuthDraft(authProviders).map((diagnostic) => ({ ...diagnostic, source: "auth" as const })),
  ];
}

/** Rebuild the merged provider list from current snapshot + drafts. */
function rebuildProviderEntries(
  snapshot: ProvidersSnapshot,
  modelsDraft: ModelsProviderDraft[],
  authDraft: AuthProviderDraft[],
): ProviderEntry[] {
  const allKeys = new Set<string>();
  const entries: ProviderEntry[] = [];

  function addIfNew(key: string, entry: ProviderEntry): void {
    if (allKeys.has(key)) return;
    allKeys.add(key);
    entries.push(entry);
  }

  // 1. AI built-in
  for (const bp of snapshot.metadata.builtInProviders) {
    const baseline = snapshot.providers.find((entry) => entry.key === bp.id);
    if (baseline?.source !== "ai-builtin") continue;
    const modelsCfg = modelsDraft.find((p) => p.key === bp.id);
    const authCfg = authDraft.find((p) => p.key === bp.id);
    addIfNew(
      bp.id,
      makeEntryFromDraft(
        bp.id,
        bp.displayName,
        "ai-builtin",
        bp.models.length,
        modelsCfg,
        authCfg,
        baseline.defaultConfig,
        baseline.credentialStatus,
      ),
    );
  }

  // 2. Desktop built-in
  for (const dp of snapshot.knownProviders) {
    const baseline = snapshot.providers.find((entry) => entry.key === dp.id);
    const builtIn = snapshot.metadata.builtInProviders.find((provider) => provider.id === dp.id);
    const modelsCfg = modelsDraft.find((p) => p.key === dp.id);
    const authCfg = authDraft.find((p) => p.key === dp.id);
    addIfNew(
      dp.id,
      makeEntryFromDraft(
        dp.id,
        dp.displayName,
        baseline?.source ?? "desktop-builtin",
        builtIn?.models.length ?? 0,
        modelsCfg,
        authCfg,
        baseline?.defaultConfig ?? builtIn?.defaultConfig,
        baseline?.credentialStatus,
      ),
    );
  }

  // 3. Custom providers from either models.json or auth.json.
  for (const mp of modelsDraft) {
    const baseline = snapshot.providers.find((entry) => entry.key === mp.key);
    addIfNew(
      mp.key,
      makeEntryFromDraft(
        mp.key,
        mp.config.name || mp.key,
        "custom",
        0,
        mp,
        authDraft.find((p) => p.key === mp.key),
        undefined,
        baseline?.credentialStatus,
      ),
    );
  }
  for (const ap of authDraft) {
    const baseline = snapshot.providers.find((entry) => entry.key === ap.key);
    const known = snapshot.knownProviders.find((provider) => provider.id === ap.key);
    addIfNew(
      ap.key,
      makeEntryFromDraft(
        ap.key,
        known?.displayName ?? ap.key,
        "custom",
        0,
        undefined,
        ap,
        undefined,
        baseline?.credentialStatus,
      ),
    );
  }

  return entries;
}

function makeEntryFromDraft(
  key: string,
  displayName: string,
  source: ProviderEntry["source"],
  builtInModelCount: number,
  modelsCfg: ModelsProviderDraft | undefined,
  authCfg: AuthProviderDraft | undefined,
  defaultConfig?: ProviderEntry["defaultConfig"],
  baselineCredentialStatus?: ProviderEntry["credentialStatus"],
): ProviderEntry {
  const credentialStatus =
    authCfg?.apiKey?.key || authCfg?.oauth
      ? "configured"
      : modelsCfg?.config.apiKey
        ? "configured"
        : baselineCredentialStatus === "env-available"
          ? "env-available"
          : "missing";

  return {
    key,
    displayName,
    source,
    builtInModelCount,
    credentialStatus,
    defaultConfig,
    providerConfig: modelsCfg
      ? {
          name: modelsCfg.config.name,
          baseUrl: modelsCfg.config.baseUrl,
          api: modelsCfg.config.api,
          apiKey: modelsCfg.config.apiKey,
          oauth: modelsCfg.config.oauth,
          authHeader: modelsCfg.config.authHeader,
          headers: modelsCfg.headers.map((h) => ({
            key: h.key,
            value: typeof h.value === "string" ? h.value : String(h.value ?? ""),
          })),
          compat: modelsCfg.compat,
        }
      : undefined,
    models: modelsCfg?.models ?? [],
    modelOverrides: modelsCfg?.modelOverrides ?? [],
    credential: authCfg?.apiKey
      ? { type: "api_key", apiKey: authCfg.apiKey.key, env: authCfg.apiKey.env }
      : authCfg?.oauth
        ? {
            type: "oauth",
            oauthInfo: {
              providerName: authCfg.oauth.providerName,
              expires: authCfg.oauth.expires,
              expired: authCfg.oauth.expired,
            },
          }
        : undefined,
  };
}
