import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { ModelsProviderForm } from "./models-provider-form.tsx";
import { ModelsProviderList } from "./models-provider-list.tsx";
import { createProviderDraft } from "./models-settings-model.ts";
import { useModelsSettingsController } from "./use-models-settings-controller.ts";

/** Session-independent structured editor for the global Pi models.json file. */
export function ModelsSettingsPage() {
  const controller = useModelsSettingsController();
  const selectedProvider =
    controller.selectedProviderIndex === undefined ? undefined : controller.draft[controller.selectedProviderIndex];
  const canSave = controller.dirty && controller.diagnostics.length === 0 && controller.status !== "saving";

  return (
    <div className="models-settings-page">
      <header className="models-settings-toolbar">
        <div className="models-settings-title">
          <h2>模型</h2>
          <span title={controller.snapshot?.path}>{controller.snapshot?.path ?? "加载 models.json"}</span>
        </div>
        <div className="models-settings-status" role="status">
          {statusText(controller.status)}
        </div>
        <div className="models-settings-actions">
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
        <div className="models-page-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.externallyChanged ? (
        <div className="models-page-message" data-tone="warning" role="alert">
          磁盘配置已改变。本地修改仍保留；重新载入可放弃本地修改，直接保存会返回冲突。
        </div>
      ) : null}
      {controller.snapshot?.preservedUnknownPaths.length ? (
        <div className="models-page-message" data-tone="info">
          检测到 {controller.snapshot.preservedUnknownPaths.length} 个当前版本无法编辑的字段，保存时会原样保留。
        </div>
      ) : null}
      {controller.diagnostics.length > 0 ? (
        <div className="models-diagnostics" role="alert" tabIndex={-1}>
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
        <div className="models-loading" aria-label="加载模型配置">
          <span />
          <span />
          <span />
        </div>
      ) : controller.status === "source-invalid" ? (
        <section className="models-source-invalid">
          <h3>models.json 无法解析</h3>
          <p>修复源文件后重新载入。为避免覆盖原内容，结构化编辑器当前不可用。</p>
          <div className="models-inline-actions">
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
          className="models-workbench"
          aria-busy={controller.status === "saving"}
          inert={controller.status === "saving" ? true : undefined}
        >
          <ModelsProviderList
            providers={controller.draft}
            metadata={controller.snapshot.metadata}
            selectedIndex={controller.selectedProviderIndex}
            onSelect={controller.selectProvider}
            onAdd={(key) => {
              const existingIndex = controller.draft.findIndex((provider) => provider.key === key);
              if (existingIndex >= 0) {
                controller.selectProvider(existingIndex);
                return;
              }
              const nextIndex = controller.draft.length;
              controller.mutate((providers) => providers.push(createProviderDraft(key)));
              controller.selectProvider(nextIndex);
            }}
          />
          <main className="models-detail-pane">
            {selectedProvider ? (
              <ModelsProviderForm
                provider={selectedProvider}
                metadata={controller.snapshot.metadata}
                onChange={(nextProvider) => {
                  const selectedIndex = controller.selectedProviderIndex;
                  if (selectedIndex === undefined) return;
                  controller.mutate((providers) => {
                    if (providers[selectedIndex]) providers[selectedIndex] = nextProvider;
                  });
                }}
                onDelete={() => {
                  const selectedIndex = controller.selectedProviderIndex;
                  if (selectedIndex === undefined) return;
                  controller.mutate((providers) => {
                    providers.splice(selectedIndex, 1);
                  });
                  const remainingCount = controller.draft.length - 1;
                  controller.selectProvider(
                    remainingCount > 0 ? Math.min(selectedIndex, remainingCount - 1) : undefined,
                  );
                }}
              />
            ) : (
              <div className="models-empty-detail">
                <h3>选择或添加 Provider</h3>
              </div>
            )}
          </main>
        </div>
      ) : null}

      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的模型配置？"
        description="离开此页面会丢失当前修改。"
        confirmLabel="放弃并离开"
        onOpenChange={(open) => {
          if (!open) controller.cancelRouteChange();
        }}
        onConfirm={controller.discardAndProceed}
      />
      <ConfirmDialog
        open={controller.pendingConfirmation !== undefined}
        title="确认 JSONC 更新？"
        description={controller.pendingConfirmation?.message ?? "保存可能移动附属注释。"}
        confirmLabel="继续保存"
        onOpenChange={(open) => {
          if (!open) controller.cancelSaveConfirmation();
        }}
        onConfirm={() => void controller.confirmSave()}
      />
    </div>
  );
}

function statusText(status: ReturnType<typeof useModelsSettingsController>["status"]): string {
  return {
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
  }[status];
}
