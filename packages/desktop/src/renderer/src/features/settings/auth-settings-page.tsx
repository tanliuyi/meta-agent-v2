import { Select } from "@renderer/components/assistant-ui/select/select";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import SquareArrowOutUpRight from "lucide-react/dist/esm/icons/square-arrow-out-up-right.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useMemo, useState } from "react";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";
import { AuthApiKeyForm } from "./auth-api-key-form.tsx";
import { AuthOauthDisplay } from "./auth-oauth-display.tsx";
import { createAuthProviderDraft } from "./auth-settings-model.ts";
import { useAuthSettingsController } from "./use-auth-settings-controller.ts";

function getDisplayName(key: string, knownProviders: AuthProviderInfo[]): string | undefined {
  return knownProviders.find((kp) => kp.id === key)?.displayName;
}

function maskApiKey(key: string): string {
  if (key.startsWith("$") || key.startsWith("!")) return key;
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function credentialTypeLabel(provider: AuthProviderDraft): {
  label: string;
  variant: "apikey" | "oauth" | "oauth-expired" | "unconfigured";
} {
  if (provider.oauth) {
    return provider.oauth.expired
      ? { label: "OAuth (已过期)", variant: "oauth-expired" }
      : { label: "OAuth", variant: "oauth" };
  }
  if (provider.apiKey && provider.apiKey.key) {
    return { label: "API Key", variant: "apikey" };
  }
  return { label: "未配置", variant: "unconfigured" };
}

/** Session-independent structured editor for the global Pi auth.json file. */
export function AuthSettingsPage() {
  const controller = useAuthSettingsController();
  const [editingProvider, setEditingProvider] = useState<AuthProviderDraft | undefined>();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AuthProviderDraft | null>(null);
  const canSave = controller.dirty && controller.diagnostics.length === 0 && controller.status !== "saving";

  const availableProviderOptions = useMemo(() => {
    if (!controller.snapshot) return [];
    return controller.snapshot.knownProviders
      .filter((kp) => !controller.draft.some((p) => p.key === kp.id))
      .map((kp) => ({ value: kp.id, label: kp.displayName }));
  }, [controller.snapshot, controller.draft]);

  function updateProvider(nextProvider: AuthProviderDraft): void {
    controller.mutate((providers) => {
      const index = providers.findIndex((p) => p.key === nextProvider.key);
      if (index >= 0) providers[index] = nextProvider;
    });
  }

  function removeProvider(key: string): void {
    controller.mutate((providers) => {
      const index = providers.findIndex((p) => p.key === key);
      if (index >= 0) providers.splice(index, 1);
    });
    setEditingProvider(undefined);
  }

  function handleConfirmAdd(): void {
    if (!addDraft) return;
    const existingIndex = controller.draft.findIndex((p) => p.key === addDraft.key);
    if (existingIndex >= 0) {
      setIsAddDialogOpen(false);
      setEditingProvider(controller.draft[existingIndex]);
      setAddDraft(null);
      return;
    }
    controller.mutate((providers) => providers.push(addDraft));
    setIsAddDialogOpen(false);
    setAddDraft(null);
  }

  return (
    <div className="settings-content">
      <header className="settings-page-heading auth-page-heading">
        <div>
          <h2>凭据</h2>
          <span className="auth-subtitle">{statusText(controller.status)}</span>
        </div>
        <div className="auth-actions">
          <TooltipIconButton tooltip="在外部编辑器打开" side="bottom" onClick={() => void controller.openExternally()}>
            <SquareArrowOutUpRight />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="重新载入"
            side="bottom"
            disabled={controller.status === "loading" || controller.status === "saving"}
            onClick={() => void controller.reload()}
          >
            <RefreshCw />
          </TooltipIconButton>
          <Button size="sm" disabled={!canSave} onClick={() => void controller.save()}>
            <Save />
            保存
          </Button>
        </div>
      </header>

      {controller.error ? (
        <div className="auth-page-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.externallyChanged ? (
        <div className="auth-page-message" data-tone="warning" role="alert">
          磁盘配置已改变。本地修改仍保留；重新载入可放弃本地修改，直接保存会返回冲突。
        </div>
      ) : null}
      {controller.diagnostics.length > 0 ? (
        <div className="auth-diagnostics" role="alert" tabIndex={-1}>
          <strong>配置需要修正</strong>
          <ul>
            {controller.diagnostics.slice(0, 8).map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${diagnostic.path.join("/")}-${index}`}>
                <code>{diagnostic.path.join(" / ") || "root"}</code>: {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {controller.status === "loading" ? (
        <div className="auth-loading" aria-label="加载凭据配置">
          <span />
          <span />
          <span />
        </div>
      ) : controller.status === "source-invalid" ? (
        <section className="settings-section">
          <div className="settings-section-heading">
            <h3>auth.json 无法解析</h3>
          </div>
          <div className="settings-row">
            <span>修复源文件后重新载入。为避免覆盖原内容，结构化编辑器当前不可用。</span>
            <div className="auth-inline-actions">
              <Button variant="outline" onClick={() => void controller.openExternally()}>
                <SquareArrowOutUpRight />
                打开文件
              </Button>
              <Button onClick={() => void controller.reload()}>
                <RefreshCw />
                重新载入
              </Button>
            </div>
          </div>
        </section>
      ) : controller.snapshot ? (
        <section
          className="settings-section"
          aria-busy={controller.status === "saving"}
          inert={controller.status === "saving" ? true : undefined}
        >
          <div className="settings-section-heading">
            <h3>已配置 Provider</h3>
            <div className="auth-add-inline">
              <Button
                size="sm"
                variant="outline"
                disabled={availableProviderOptions.length === 0}
                onClick={() => {
                  setIsAddDialogOpen(true);
                  setAddDraft(null);
                }}
              >
                <Plus />
                添加凭证
              </Button>
            </div>
          </div>
          {controller.draft.length > 0 ? (
            <div className="auth-provider-cards">
              {controller.draft.map((provider) => {
                const typeInfo = credentialTypeLabel(provider);
                const displayName = getDisplayName(provider.key, controller.snapshot!.knownProviders);
                const source = provider.apiKey?.key ? "auth.json" : provider.oauth ? "OAuth" : undefined;
                return (
                  <button
                    type="button"
                    key={provider.key}
                    className="settings-row auth-provider-row"
                    onClick={() => setEditingProvider(provider)}
                  >
                    <span className="auth-provider-row-name">{displayName || provider.key}</span>
                    <span className="auth-provider-row-meta">
                      {provider.key}
                      {provider.apiKey?.key ? (
                        <span className="auth-provider-row-preview">{maskApiKey(provider.apiKey.key)}</span>
                      ) : null}
                      <span className={`auth-type-badge auth-type-badge--${typeInfo.variant}`}>{typeInfo.label}</span>
                      {source ? <span className="auth-source-badge">{source}</span> : null}
                    </span>
                    <Settings2 />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="settings-row auth-empty-row">
              <span>暂无 Provider，点击上方按钮添加第一个。</span>
            </div>
          )}
        </section>
      ) : null}

      {editingProvider && controller.snapshot ? (
        <Dialog
          open={editingProvider !== undefined}
          onOpenChange={(open) => {
            if (!open) setEditingProvider(undefined);
          }}
        >
          <DialogContent className="auth-editor-dialog">
            <div className="auth-editor-provider-header">
              <div>
                <span className="auth-editor-eyebrow">
                  {controller.snapshot.knownProviders.find((kp) => kp.id === editingProvider.key)
                    ? "内置 Provider"
                    : "自定义 Provider"}
                </span>
                <h2 className="auth-editor-title">
                  {controller.snapshot.knownProviders.find((kp) => kp.id === editingProvider.key)?.displayName ??
                    editingProvider.key}
                </h2>
                <p className="auth-editor-key">{editingProvider.key}</p>
              </div>
            </div>

            <div className="auth-editor-form">
              {editingProvider.apiKey && (
                <AuthApiKeyForm
                  provider={editingProvider}
                  knownProviders={controller.snapshot.knownProviders}
                  onChange={updateProvider}
                />
              )}

              {editingProvider.oauth && (
                <AuthOauthDisplay provider={editingProvider} onRemove={() => removeProvider(editingProvider.key)} />
              )}

              {!editingProvider.apiKey && !editingProvider.oauth && (
                <div className="auth-editor-empty">
                  <p>该 provider 没有本地凭据配置。可添加 API key 或使用 OAuth 登录。</p>
                  <Button
                    onClick={() =>
                      updateProvider({
                        ...editingProvider,
                        apiKey: { key: "", env: [] },
                      })
                    }
                  >
                    添加 API Key
                  </Button>
                </div>
              )}

              <Button variant="destructive" size="sm" onClick={() => removeProvider(editingProvider.key)}>
                <Trash2 />
                删除
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {isAddDialogOpen && controller.snapshot ? (
        <Dialog
          open={isAddDialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setIsAddDialogOpen(false);
              setAddDraft(null);
            }
          }}
        >
          <DialogContent className="auth-editor-dialog">
            <div className="auth-editor-provider-header">
              <div>
                <span className="auth-editor-eyebrow">添加 Provider 凭据</span>
                <h2 className="auth-editor-title">添加 Provider</h2>
              </div>
            </div>

            <div className="auth-editor-form">
              <div className="auth-field">
                <label className="auth-field-label">Provider</label>
                <Select
                  value={addDraft?.key ?? ""}
                  placeholder="选择内置 Provider"
                  onValueChange={(nextValue) => {
                    setAddDraft(createAuthProviderDraft(nextValue));
                  }}
                  options={availableProviderOptions}
                />
              </div>

              {addDraft && (
                <AuthApiKeyForm
                  provider={addDraft}
                  knownProviders={controller.snapshot.knownProviders}
                  onChange={setAddDraft}
                />
              )}

              <div className="auth-inline-actions" style={{ justifyContent: "flex-end", marginTop: "var(--space-4)" }}>
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsAddDialogOpen(false);
                    setAddDraft(null);
                  }}
                >
                  取消
                </Button>
                <Button disabled={!addDraft || !addDraft.apiKey?.key.trim()} onClick={handleConfirmAdd}>
                  添加
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的凭据配置？"
        description="离开此页面会丢失当前修改。"
        confirmLabel="放弃并离开"
        onOpenChange={(open) => {
          if (!open) controller.cancelRouteChange();
        }}
        onConfirm={controller.discardAndProceed}
      />
    </div>
  );
}

function statusText(status: ReturnType<typeof useAuthSettingsController>["status"]): string {
  const map: Record<string, string> = {
    loading: "加载中",
    missing: "尚未创建 · 新会话生效",
    "ready-clean": "已同步 · 新会话生效",
    "ready-dirty-valid": "有未保存修改",
    "ready-dirty-invalid": "配置无效",
    "source-invalid": "源文件无效",
    saving: "保存中",
    saved: "已保存 · 新会话生效",
    conflict: "磁盘版本已改变",
    "read-error": "读取失败",
    "write-error": "保存失败",
  };
  return map[status] ?? status;
}
