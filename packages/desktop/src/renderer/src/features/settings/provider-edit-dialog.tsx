import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import Boxes from "lucide-react/dist/esm/icons/boxes.mjs";
import Globe from "lucide-react/dist/esm/icons/globe.mjs";
import KeyRound from "lucide-react/dist/esm/icons/key-round.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Wrench from "lucide-react/dist/esm/icons/wrench.mjs";
import { useEffect, useRef, useState } from "react";
import type {
  AuthOauthLoginEvent,
  AuthProviderDraft,
  AuthProviderInfo,
} from "../../../../shared/auth-config-contracts.ts";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import type { ProviderEntry, ProvidersConfigMetadata } from "../../../../shared/providers-config-contracts.ts";
import { ProviderCompatTab } from "./provider-compat-tab.tsx";
import { ProviderConnectionForm } from "./provider-connection-form.tsx";
import { ProviderCredentialsForm } from "./provider-credentials-form.tsx";
import {
  commitProviderEditorDrafts,
  normalizeProviderModelsDraft,
  providerEditorDraftsChanged,
} from "./provider-edit-model.ts";
import { ProviderModelsTab } from "./provider-models-tab.tsx";
import { ProviderOauthLoginDialog, type ProviderOauthLoginState } from "./provider-oauth-login-dialog.tsx";
import { ProviderOverridesTab } from "./provider-overrides-tab.tsx";
import type { ProviderDrafts, ProvidersSettingsController } from "./use-providers-controller.ts";

interface ProviderEditDialogProps {
  entry: ProviderEntry;
  metadata: ProvidersConfigMetadata;
  knownProviders: AuthProviderInfo[];
  modelsDraft: ModelsProviderDraft[];
  authDraft: AuthProviderDraft[];
  controller: ProvidersSettingsController;
  onClose(): void;
}

/** Tabbed dialog for editing a single provider's connection, credentials, models, overrides, and compat. */
export function ProviderEditDialog({
  entry,
  metadata,
  knownProviders,
  modelsDraft,
  authDraft,
  controller,
  onClose,
}: ProviderEditDialogProps) {
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [oauthLogin, setOauthLogin] = useState<ProviderOauthLoginState>();
  const [activeTab, setActiveTab] = useState("connection");
  const sourceModelsProvider = modelsDraft.find((provider) => provider.key === entry.key);
  const sourceAuthProvider = authDraft.find((provider) => provider.key === entry.key);
  const modelsProviderRef = useRef<ModelsProviderDraft | undefined>(
    sourceModelsProvider ? structuredClone(sourceModelsProvider) : undefined,
  );
  const authProviderRef = useRef<AuthProviderDraft | undefined>(
    sourceAuthProvider ? structuredClone(sourceAuthProvider) : undefined,
  );
  const localDirty = useRef(false);
  const skipCommit = useRef(false);
  const knownProvider = knownProviders.find((provider) => provider.id === entry.key);
  const builtIn = metadata.builtInProviders.find((provider) => provider.id === entry.key);

  useEffect(
    () =>
      window.desktop.auth.onOauthEvent((event: AuthOauthLoginEvent) => {
        setOauthLogin((current) =>
          current?.loginId === event.loginId ? { ...current, events: [...current.events, event] } : current,
        );
      }),
    [],
  );

  useEffect(() => {
    if (localDirty.current) return;
    const nextModelsProvider = sourceModelsProvider ? structuredClone(sourceModelsProvider) : undefined;
    const nextAuthProvider = sourceAuthProvider ? structuredClone(sourceAuthProvider) : undefined;
    modelsProviderRef.current = nextModelsProvider;
    authProviderRef.current = nextAuthProvider;
  }, [sourceAuthProvider, sourceModelsProvider]);

  function startOauthLogin(): void {
    if (!knownProvider?.oauth || controller.dirty || localDirty.current) return;
    const loginId = crypto.randomUUID();
    setOauthLogin({ loginId, providerName: knownProvider.oauth.name, active: true, events: [] });
    void window.desktop.auth.loginOauth({ loginId, providerId: entry.key }).then(
      async () => {
        await controller.reload();
        setOauthLogin((current) => (current?.loginId === loginId ? undefined : current));
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setOauthLogin((current) => {
          if (current?.loginId !== loginId) return current;
          if (message === "Login cancelled" || message.includes("aborted")) return undefined;
          return { ...current, active: false, error: message };
        });
      },
    );
  }

  function markLocalDirty(): void {
    if (localDirty.current) return;
    localDirty.current = true;
    void window.desktop.providers.setEditorDirty(true);
  }

  function updateModelsProvider(updated: ModelsProviderDraft): void {
    markLocalDirty();
    modelsProviderRef.current = updated;
    if (updated.key !== entry.key && authProviderRef.current) {
      const current = authProviderRef.current;
      const renamed = { ...current, key: updated.key, origin: current.origin ?? entry.key };
      authProviderRef.current = renamed;
    }
  }

  function updateAuthProvider(updated: AuthProviderDraft | undefined): void {
    markLocalDirty();
    authProviderRef.current = updated;
  }

  function commitAndClose(): void {
    if (!skipCommit.current && localDirty.current) {
      const nextModelsProvider = normalizeProviderModelsDraft(modelsProviderRef.current, entry.defaultConfig);
      const nextAuthProvider = authProviderRef.current;
      if (providerEditorDraftsChanged(sourceModelsProvider, sourceAuthProvider, nextModelsProvider, nextAuthProvider)) {
        controller.mutate((drafts: ProviderDrafts) => {
          commitProviderEditorDrafts(drafts, {
            entryKey: entry.key,
            sourceModelsOriginProviderKey: sourceModelsProvider?.origin?.providerKey,
            modelsProvider: nextModelsProvider,
            authProvider: nextAuthProvider,
          });
        });
      } else {
        void window.desktop.providers.setEditorDirty(controller.dirty);
      }
      localDirty.current = false;
    }
    onClose();
  }

  function deleteProvider(): void {
    skipCommit.current = true;
    controller.mutate((drafts: ProviderDrafts) => {
      drafts.modelsProviders = drafts.modelsProviders.filter((provider) => provider.key !== entry.key);
      drafts.authProviders = drafts.authProviders.filter((provider) => provider.key !== entry.key);
    });
    onClose();
  }

  const modelsProvider = modelsProviderRef.current;
  const authProvider = authProviderRef.current;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) commitAndClose();
      }}
    >
      <DialogContent className="providers-editor-dialog w-[min(65rem,calc(100vw-32px))] max-w-none gap-0 p-0">
        <div className="providers-editor-header">
          <div>
            <h2 className="providers-editor-title">{entry.displayName}</h2>
            <p className="providers-editor-subtitle">{entry.key}</p>
          </div>
        </div>

        <Tabs className="settings-tabs" value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="settings-tab-list" aria-label="Provider 配置">
            <TabsTrigger value="connection">
              <Globe aria-hidden="true" />
              连接
            </TabsTrigger>
            <TabsTrigger value="credentials">
              <KeyRound aria-hidden="true" />
              凭据
            </TabsTrigger>
            <TabsTrigger value="models">
              <Boxes aria-hidden="true" />
              模型
            </TabsTrigger>
            <TabsTrigger value="overrides">
              <SlidersHorizontal aria-hidden="true" />
              覆盖
            </TabsTrigger>
            <TabsTrigger value="compat">
              <Wrench aria-hidden="true" />
              兼容性
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                <ProviderConnectionForm
                  provider={modelsProvider}
                  entryKey={entry.key}
                  defaultConfig={entry.defaultConfig}
                  knownApis={metadata.knownApis}
                  onChange={updateModelsProvider}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="credentials" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                <ProviderCredentialsForm
                  provider={authProvider}
                  knownProvider={knownProvider}
                  entryKey={entry.key}
                  oauthDisabled={controller.dirty || localDirty.current}
                  onChange={updateAuthProvider}
                  onOauthLogin={startOauthLogin}
                  onDelete={() => updateAuthProvider(undefined)}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="models" className="settings-tab-content">
            {modelsProvider || builtIn ? (
              <ProviderModelsTab
                provider={modelsProvider}
                metadata={metadata}
                builtInModels={builtIn?.models}
                onChange={updateModelsProvider}
              />
            ) : (
              <div className="settings-tab-scroll">
                <div className="settings-tab-scroll-content">
                  <p className="providers-editor-empty">该 Provider 没有自定义模型。</p>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="overrides" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                {modelsProvider || builtIn ? (
                  <ProviderOverridesTab
                    provider={modelsProvider}
                    entryKey={entry.key}
                    builtInModels={builtIn?.models}
                    onChange={updateModelsProvider}
                  />
                ) : (
                  <p className="providers-editor-empty">该 Provider 没有模型覆盖。</p>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="compat" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                <ProviderCompatTab provider={modelsProvider} entryKey={entry.key} onChange={updateModelsProvider} />
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="providers-editor-footer flex-row justify-between sm:justify-between">
          <Button variant="ghost" className="providers-editor-delete" onClick={() => setDeleteConfirmationOpen(true)}>
            <Trash2 />
            删除
          </Button>
          <Button onClick={commitAndClose}>完成</Button>
        </DialogFooter>
      </DialogContent>

      {oauthLogin ? <ProviderOauthLoginDialog state={oauthLogin} onClose={() => setOauthLogin(undefined)} /> : null}

      <ConfirmDialog
        open={deleteConfirmationOpen}
        title={`删除 ${entry.displayName}？`}
        description="将删除该 Provider 的本地模型和凭据配置。此修改需要保存后才会生效。"
        confirmLabel="删除 Provider"
        onOpenChange={setDeleteConfirmationOpen}
        onConfirm={deleteProvider}
      />
    </Dialog>
  );
}
