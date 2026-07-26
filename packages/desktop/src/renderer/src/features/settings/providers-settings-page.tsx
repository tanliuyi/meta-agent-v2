import { Select } from "@renderer/components/assistant-ui/select/select";
import type { SelectOption } from "@renderer/components/assistant-ui/select/select-types";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import FilterIcon from "lucide-react/dist/esm/icons/filter.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import SearchIcon from "lucide-react/dist/esm/icons/search.mjs";
import XIcon from "lucide-react/dist/esm/icons/x.mjs";
import { useDeferredValue, useMemo, useState } from "react";
import type { ProviderEntry } from "../../../../shared/providers-config-contracts.ts";
import { AddProviderDialog } from "./add-provider-dialog.tsx";
import { createProviderDraft } from "./models-settings-model.ts";
import { ProviderCard } from "./provider-card.tsx";
import { ProviderEditDialog } from "./provider-edit-dialog.tsx";
import type { ProviderDrafts, ProvidersSettingsController } from "./use-providers-controller.ts";
import { useProvidersSettingsController } from "./use-providers-controller.ts";

const SOURCE_OPTIONS: SelectOption[] = [
  { value: "all", label: "全部来源" },
  { value: "ai-builtin", label: "内置" },
  { value: "desktop-builtin", label: "内置(desktop)" },
  { value: "custom", label: "自定义" },
];

const CREDENTIAL_OPTIONS: SelectOption[] = [
  { value: "all", label: "全部凭据" },
  { value: "configured", label: "已配置" },
  { value: "missing", label: "未配置" },
  { value: "env-available", label: "环境变量" },
];

/** Unified providers settings page — replaces both models and auth pages. */
export function ProvidersSettingsPage() {
  const controller = useProvidersSettingsController();
  const snapshot = controller.snapshot;
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterSource, setFilterSource] = useState<ProviderEntry["source"] | "all">("all");
  const [filterCredentialStatus, setFilterCredentialStatus] = useState<ProviderEntry["credentialStatus"] | "all">(
    "all",
  );
  const deferredFilterText = useDeferredValue(filterText);

  const selected = controller.selectedProviderKey
    ? controller.providers.find((p) => p.key === controller.selectedProviderKey)
    : undefined;

  const filteredProviders = useMemo(() => {
    let list = controller.providers;
    if (deferredFilterText) {
      const lower = deferredFilterText.toLowerCase();
      list = list.filter((p) => p.displayName.toLowerCase().includes(lower) || p.key.toLowerCase().includes(lower));
    }
    if (filterSource !== "all") {
      list = list.filter((p) => p.source === filterSource);
    }
    if (filterCredentialStatus !== "all") {
      list = list.filter((p) => p.credentialStatus === filterCredentialStatus);
    }
    return list;
  }, [controller.providers, deferredFilterText, filterSource, filterCredentialStatus]);

  const hasActiveFilter = filterText !== "" || filterSource !== "all" || filterCredentialStatus !== "all";

  return (
    <div className="settings-content providers-settings">
      <header className="settings-page-heading providers-page-heading">
        <div>
          <h2>Provider</h2>
          <span className="providers-subtitle">{statusText(controller.status)}</span>
        </div>
        <div className="providers-actions">
          <Button size="sm" variant="outline" onClick={() => setShowAddDialog(true)}>
            <Plus />
            新增
          </Button>
          <Button
            size="sm"
            disabled={!controller.dirty || controller.diagnostics.length > 0 || controller.status === "saving"}
            onClick={() => void controller.save()}
          >
            保存
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={controller.status === "loading"}
            onClick={() => void controller.reload()}
          >
            重新载入
          </Button>
          <Button size="sm" variant="outline" onClick={() => void controller.openModelsExternally()}>
            models.json
          </Button>
          <Button size="sm" variant="outline" onClick={() => void controller.openAuthExternally()}>
            auth.json
          </Button>
        </div>
      </header>

      {controller.error ? (
        <div className="providers-page-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.externallyChanged ? (
        <div className="providers-page-message" data-tone="warning" role="alert">
          磁盘配置已改变。本地修改仍保留；重新载入可放弃本地修改，直接保存会返回冲突。
        </div>
      ) : null}

      {snapshot?.preservedUnknownPaths.length ? (
        <div className="providers-page-message" data-tone="info">
          检测到 {snapshot.preservedUnknownPaths.length} 个当前版本无法编辑的字段，保存时会原样保留。
        </div>
      ) : null}

      {controller.diagnostics.length > 0 ? (
        <div className="providers-diagnostics" role="alert" tabIndex={-1}>
          <strong>配置需要修正</strong>
          <ul>
            {controller.diagnostics.slice(0, 8).map((diagnostic, index) => (
              <li key={`${diagnostic.source}-${diagnostic.code}-${diagnostic.path.join("/")}-${index}`}>
                <code>{diagnostic.path.join(" / ") || "root"}</code>: {diagnostic.message}
                <span className="providers-diagnostic-source">({diagnostic.source})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {controller.status === "loading" ? (
        <div className="providers-loading" aria-label="加载 Provider 配置">
          <span />
          <span />
          <span />
        </div>
      ) : snapshot ? (
        <>
          <div className="providers-filter-bar">
            <div className="providers-filter-input-wrap">
              <SearchIcon className="providers-filter-input-icon" />
              <Input
                className="providers-filter-input pl-8"
                placeholder="搜索名称或 key…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              {filterText && (
                <Button
                  className="providers-filter-clear"
                  variant="ghost"
                  size="icon"
                  onClick={() => setFilterText("")}
                  aria-label="清除搜索"
                >
                  <XIcon />
                </Button>
              )}
            </div>
            <div className="providers-filter-dropdowns">
              <Select
                options={SOURCE_OPTIONS}
                value={filterSource}
                onValueChange={(v) => setFilterSource(v as ProviderEntry["source"] | "all")}
                placeholder="全部来源"
                className="border border-input bg-background"
              />
              <Select
                options={CREDENTIAL_OPTIONS}
                value={filterCredentialStatus}
                onValueChange={(v) => setFilterCredentialStatus(v as ProviderEntry["credentialStatus"] | "all")}
                placeholder="全部凭据"
                className="border border-input bg-background"
              />
              {hasActiveFilter && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilterText("");
                    setFilterSource("all");
                    setFilterCredentialStatus("all");
                  }}
                >
                  <FilterIcon />
                  重置
                </Button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section
              className="providers-list"
              aria-busy={controller.status === "saving"}
              inert={controller.status === "saving" ? true : undefined}
            >
              {filteredProviders.map((entry) => (
                <ProviderCard key={entry.key} entry={entry} onEdit={controller.selectProvider} />
              ))}
              {filteredProviders.length === 0 ? (
                <div className="providers-empty">
                  {hasActiveFilter ? "没有匹配的 Provider。" : "暂无 Provider 数据。"}
                </div>
              ) : null}
            </section>
          </div>
        </>
      ) : null}

      {selected && snapshot ? (
        <ProviderEditDialog
          entry={selected}
          metadata={snapshot.metadata}
          knownProviders={snapshot.knownProviders}
          modelsDraft={controller.modelsDraft}
          authDraft={controller.authDraft}
          controller={controller}
          onClose={() => controller.selectProvider(undefined)}
        />
      ) : null}

      {showAddDialog ? (
        <AddProviderDialog
          knownProviders={snapshot?.knownProviders ?? []}
          onConfirm={(key) => {
            setShowAddDialog(false);
            controller.mutate((drafts: ProviderDrafts) => {
              if (!drafts.modelsProviders.some((p) => p.key === key)) {
                drafts.modelsProviders.push(createProviderDraft(key));
              }
            });
            controller.selectProvider(key);
          }}
          onCancel={() => setShowAddDialog(false)}
        />
      ) : null}

      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的配置？"
        description="离开此页面会丢失当前修改。"
        confirmLabel="放弃并离开"
        onCancel={controller.cancelRouteChange}
        onConfirm={controller.discardAndProceed}
      />
      <ConfirmDialog
        open={controller.pendingConfirmation !== undefined}
        title="确认 JSONC 更新？"
        description={controller.pendingConfirmation?.message ?? "保存可能移动附属注释。"}
        confirmLabel="继续保存"
        onCancel={controller.cancelSaveConfirmation}
        onConfirm={() => void controller.confirmSave()}
      />
    </div>
  );
}

/** Map controller status to a user-facing string. */
function statusText(status: ProvidersSettingsController["status"]): string {
  const map: Record<string, string> = {
    loading: "加载中",
    missing: "尚未创建 · 新会话生效",
    "ready-clean": "已同步 · 新会话生效",
    "ready-dirty-valid": "有未保存修改",
    "ready-dirty-invalid": "配置无效",
    saving: "保存中",
    saved: "已保存 · 新会话生效",
    conflict: "磁盘版本已改变",
    "read-error": "读取失败",
    "write-error": "保存失败",
  };
  return map[status] ?? status;
}
