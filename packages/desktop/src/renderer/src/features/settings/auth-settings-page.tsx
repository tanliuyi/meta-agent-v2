import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import type { AuthProviderDraft } from "../../../../shared/auth-config-contracts.ts";
import { AuthProviderDetail } from "./auth-provider-detail.tsx";
import { AuthProviderList } from "./auth-provider-list.tsx";
import { createAuthProviderDraft } from "./auth-settings-model.ts";
import { useAuthSettingsController } from "./use-auth-settings-controller.ts";

/** Session-independent structured editor for the global Pi auth.json file. */
export function AuthSettingsPage() {
  const controller = useAuthSettingsController();
  const selectedProvider = controller.selectedKey
    ? controller.draft.find((p) => p.key === controller.selectedKey)
    : undefined;
  const canSave = controller.dirty && controller.diagnostics.length === 0 && controller.status !== "saving";

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
    if (controller.selectedKey === key) {
      const remaining = controller.draft.filter((p) => p.key !== key);
      controller.selectProvider(remaining.length > 0 ? remaining[0]!.key : undefined);
    }
  }

  function handleAdd(key: string): void {
    const existingIndex = controller.draft.findIndex((p) => p.key === key);
    if (existingIndex >= 0) {
      controller.selectProvider(key);
      return;
    }
    const draft = createAuthProviderDraft(key);
    controller.mutate((providers) => providers.push(draft));
    controller.selectProvider(key);
  }

  return (
    <div className="auth-settings-page">
      <header className="auth-settings-toolbar">
        <div className="auth-settings-title">
          <h2>凭据</h2>
          <span title={controller.snapshot?.path}>{controller.snapshot?.path ?? "加载 auth.json"}</span>
        </div>
        <div className="auth-settings-status" role="status">
          {statusText(controller.status)}
        </div>
        <div className="auth-settings-actions">
          <Button
            size="icon"
            variant="ghost"
            title="在外部编辑器打开"
            aria-label="在外部编辑器打开"
            onClick={() => void controller.openExternally()}
          >
            <ExternalLink />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="重新载入"
            aria-label="重新载入"
            disabled={controller.status === "loading" || controller.status === "saving"}
            onClick={() => void controller.reload()}
          >
            <RefreshCw />
          </Button>
          <Button disabled={!canSave} onClick={() => void controller.save()}>
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
        <section className="auth-source-invalid">
          <h3>auth.json 无法解析</h3>
          <p>修复源文件后重新载入。为避免覆盖原内容，结构化编辑器当前不可用。</p>
          <div className="auth-inline-actions">
            <Button variant="outline" onClick={() => void controller.openExternally()}>
              <ExternalLink />
              打开文件
            </Button>
            <Button onClick={() => void controller.reload()}>
              <RefreshCw />
              重新载入
            </Button>
          </div>
        </section>
      ) : controller.snapshot ? (
        <div
          className="auth-workbench"
          aria-busy={controller.status === "saving"}
          inert={controller.status === "saving" ? true : undefined}
        >
          <AuthProviderList
            providers={controller.draft}
            knownProviders={controller.snapshot.knownProviders}
            selectedKey={controller.selectedKey}
            onSelect={controller.selectProvider}
            onAdd={handleAdd}
          />
          <main className="auth-detail-pane">
            {selectedProvider ? (
              <AuthProviderDetail
                provider={selectedProvider}
                knownProviders={controller.snapshot.knownProviders}
                onChange={updateProvider}
                onRemove={() => removeProvider(selectedProvider.key)}
              />
            ) : (
              <div className="auth-empty-detail">
                <div className="auth-empty-icon">
                  <Plus />
                </div>
                <h3>添加凭据</h3>
                <p>从左侧选择或添加 Provider，然后配置 API key。</p>
              </div>
            )}
          </main>
        </div>
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
