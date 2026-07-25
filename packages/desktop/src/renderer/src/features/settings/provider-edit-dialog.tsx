import * as Tabs from "@radix-ui/react-tabs";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useState } from "react";
import type {
  AuthOauthLoginEvent,
  AuthProviderDraft,
  AuthProviderInfo,
} from "../../../../shared/auth-config-contracts.ts";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import type { ProviderEntry, ProvidersConfigMetadata } from "../../../../shared/providers-config-contracts.ts";
import { ModelsCompatEditor } from "./models-compat-editor.tsx";
import { createProviderDraft } from "./models-settings-model.ts";
import { ProviderConnectionForm } from "./provider-connection-form.tsx";
import { ProviderCredentialsForm } from "./provider-credentials-form.tsx";
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
  const modelsProvider = modelsDraft.find((p) => p.key === entry.key);
  const authProvider = authDraft.find((p) => p.key === entry.key);
  const knownProvider = knownProviders.find((provider) => provider.id === entry.key);
  const builtIn = metadata.builtInProviders.find((bp) => bp.id === entry.key);

  useEffect(
    () =>
      window.desktop.auth.onOauthEvent((event: AuthOauthLoginEvent) => {
        setOauthLogin((current) =>
          current?.loginId === event.loginId ? { ...current, events: [...current.events, event] } : current,
        );
      }),
    [],
  );

  function startOauthLogin(): void {
    if (!knownProvider?.oauth || controller.dirty) return;
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

  function updateModelsProvider(updated: ModelsProviderDraft): void {
    controller.mutate((drafts: ProviderDrafts) => {
      const idx = drafts.modelsProviders.findIndex(
        (provider) =>
          provider.key === entry.key ||
          (modelsProvider?.origin !== undefined && provider.origin?.providerKey === modelsProvider.origin.providerKey),
      );
      if (idx >= 0) drafts.modelsProviders[idx] = updated;
      else drafts.modelsProviders.push(updated);

      if (updated.key !== entry.key) {
        const authIndex = drafts.authProviders.findIndex((provider) => provider.key === entry.key);
        if (authIndex >= 0) {
          const current = drafts.authProviders[authIndex]!;
          drafts.authProviders[authIndex] = { ...current, key: updated.key, origin: current.origin ?? entry.key };
        }
      }
    });
    if (updated.key !== entry.key) controller.selectProvider(updated.key);
  }

  function updateAuthProvider(updated: AuthProviderDraft): void {
    controller.mutate((drafts: ProviderDrafts) => {
      const idx = drafts.authProviders.findIndex((p) => p.key === entry.key);
      if (idx >= 0) drafts.authProviders[idx] = updated;
      else drafts.authProviders.push(updated);
    });
  }

  function deleteProvider(): void {
    controller.mutate((drafts: ProviderDrafts) => {
      drafts.modelsProviders = drafts.modelsProviders.filter((p) => p.key !== entry.key);
      drafts.authProviders = drafts.authProviders.filter((p) => p.key !== entry.key);
    });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="providers-editor-dialog"
        style={{ width: "min(65rem, calc(100vw - 2rem))", maxWidth: "none", padding: 0, gap: 0 }}
      >
        <div className="providers-editor-header">
          <div>
            <h2 className="providers-editor-title">{entry.displayName}</h2>
            <p className="providers-editor-subtitle">{entry.key}</p>
          </div>
        </div>

        <Tabs.Root className="settings-tabs" defaultValue="connection">
          <Tabs.List className="settings-tab-list" aria-label="Provider 配置">
            <Tabs.Trigger value="connection">连接</Tabs.Trigger>
            <Tabs.Trigger value="credentials">凭据</Tabs.Trigger>
            <Tabs.Trigger value="models">模型</Tabs.Trigger>
            <Tabs.Trigger value="overrides">覆盖</Tabs.Trigger>
            <Tabs.Trigger value="compat">兼容性</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="connection" className="settings-tab-content">
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
          </Tabs.Content>

          <Tabs.Content value="credentials" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                <ProviderCredentialsForm
                  provider={authProvider}
                  knownProvider={knownProvider}
                  entryKey={entry.key}
                  oauthDisabled={controller.dirty}
                  onChange={updateAuthProvider}
                  onOauthLogin={startOauthLogin}
                  onDelete={() => {
                    controller.mutate((drafts: ProviderDrafts) => {
                      drafts.authProviders = drafts.authProviders.filter((p) => p.key !== entry.key);
                    });
                  }}
                />
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="models" className="settings-tab-content">
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
          </Tabs.Content>

          <Tabs.Content value="overrides" className="settings-tab-content">
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
          </Tabs.Content>

          <Tabs.Content value="compat" className="settings-tab-content">
            <div className="settings-tab-scroll">
              <div className="settings-tab-scroll-content">
                <ModelsCompatEditor
                  value={modelsProvider?.compat}
                  onChange={(compat) =>
                    updateModelsProvider({ ...(modelsProvider ?? createProviderDraft(entry.key)), compat })
                  }
                />
              </div>
            </div>
          </Tabs.Content>
        </Tabs.Root>

        <DialogFooter className="providers-editor-footer">
          <Button variant="ghost" onClick={() => setDeleteConfirmationOpen(true)}>
            <Trash2 />
            删除
          </Button>
          <Button onClick={onClose}>完成</Button>
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
