import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Switch } from "@renderer/shared/ui/switch";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { useSearch } from "@tanstack/react-router";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useState } from "react";
import { ExtensionRow } from "./extension-row.tsx";
import { ExtensionSection } from "./extension-section.tsx";
import { useExtensionsSettingsController } from "./use-extensions-settings-controller.ts";

export function ExtensionsSettingsPage() {
  const search = useSearch({ from: "/settings" });
  const returnSession = settingsReturnSession(search);
  const controller = useExtensionsSettingsController(returnSession?.projectId, returnSession?.threadId);
  const [confirmApply, setConfirmApply] = useState(false);
  const snapshot = controller.snapshot;
  const builtin = snapshot?.entries.filter((entry) => entry.source === "builtin") ?? [];
  const curated = snapshot?.entries.filter((entry) => entry.source === "curated") ?? [];
  const development = snapshot?.entries.filter((entry) => entry.source === "development") ?? [];

  return (
    <div className="settings-content extensions-settings">
      <header className="settings-page-heading extensions-page-heading">
        <div>
          <h2>扩展</h2>
          <span>Desktop 仅加载内建、精选和明确批准的本地扩展。</span>
        </div>
        {snapshot?.reloadRequired && returnSession ? (
          <Button variant="outline" disabled={controller.mutating} onClick={() => setConfirmApply(true)}>
            <RotateCw />
            应用到当前会话
          </Button>
        ) : null}
      </header>

      {snapshot?.diagnostics.length ? (
        <div className="extensions-message" data-tone="warning" role="status">
          {snapshot.diagnostics.map((diagnostic) => `${diagnostic.extensionId}: ${diagnostic.message}`).join("\n")}
        </div>
      ) : null}
      {controller.error ? (
        <div className="extensions-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.applyResult ? (
        <div
          className="extensions-message"
          data-tone={controller.applyResult.status === "rolled-back" ? "warning" : "info"}
          role="status"
        >
          {controller.applyResult.status === "rolled-back"
            ? `新扩展配置启动失败，已恢复上一配置。${controller.applyResult.error ?? ""}`
            : "扩展配置已应用。"}
        </div>
      ) : null}
      {snapshot?.reloadRequired && !returnSession ? (
        <div className="extensions-message" data-tone="info" role="status">
          更改将在下次启动会话时生效。
        </div>
      ) : null}

      <ExtensionSection title="内建" entries={builtin} loading={controller.loading} />

      <ExtensionSection
        title="精选"
        entries={curated}
        empty="当前版本没有可选的精选扩展。"
        loading={controller.loading}
        renderAction={(entry) => (
          <Switch
            checked={entry.configuredEnabled}
            disabled={controller.mutating}
            aria-label={`${entry.displayName} 启用状态`}
            onCheckedChange={(enabled) =>
              void controller.mutate({ type: "set-curated-enabled", extensionId: entry.id, enabled })
            }
          />
        )}
      />

      <section className="settings-section extensions-development" aria-labelledby="development-extensions-heading">
        <div className="settings-section-heading extensions-section-heading">
          <div>
            <h3 id="development-extensions-heading">Developer Mode</h3>
            <span>
              本地扩展是普通 Node 代码，可访问文件、环境变量、网络和子进程；可能破坏 thread worker 或共享 draft metadata
              worker，不保证兼容 Pi TUI，也不提供自动更新或迁移。
            </span>
          </div>
          <Switch
            checked={snapshot?.developerMode ?? false}
            disabled={!snapshot || controller.mutating}
            aria-label="Developer Mode"
            onCheckedChange={(enabled) => void controller.mutate({ type: "set-developer-mode", enabled })}
          />
        </div>
        <div className="extensions-list">
          {development.map((entry) => (
            <ExtensionRow
              key={entry.id}
              entry={entry}
              action={
                <div className="extensions-row-actions">
                  <Switch
                    checked={entry.configuredEnabled}
                    disabled={!snapshot?.developerMode || controller.mutating}
                    aria-label={`${entry.displayName} 启用状态`}
                    onCheckedChange={(enabled) =>
                      void controller.mutate({ type: "set-development-enabled", extensionId: entry.id, enabled })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={controller.mutating}
                    aria-label={`移除 ${entry.displayName}`}
                    title="移除批准记录"
                    onClick={() => void controller.mutate({ type: "remove-development-entry", extensionId: entry.id })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              }
            />
          ))}
          {development.length === 0 && !controller.loading ? (
            <div className="extensions-empty">没有已批准的本地扩展。</div>
          ) : null}
        </div>
        <div className="extensions-add-row">
          <Button
            variant="outline"
            disabled={!snapshot?.developerMode || controller.mutating}
            onClick={() => void controller.chooseDevelopmentEntry()}
          >
            <FolderPlus />
            添加本地扩展
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmApply}
        title="重新加载当前会话扩展"
        description="当前运行将被中止。Desktop 会先停止旧 worker，再使用新扩展配置启动；启动失败时自动恢复上一配置。"
        confirmLabel="应用并重连"
        onOpenChange={setConfirmApply}
        onConfirm={() => {
          if (returnSession) void controller.apply(returnSession.projectId, returnSession.threadId, true);
        }}
      />
    </div>
  );
}
