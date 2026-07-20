import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import { useEffect, useRef, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsProviderForm } from "./models-provider-form.tsx";
import { ModelsProviderList } from "./models-provider-list.tsx";
import { ModelsProviderOverview } from "./models-provider-overview.tsx";
import { createProviderDraft, modelsDraftsEqual } from "./models-settings-model.ts";
import { useModelsSettingsController } from "./use-models-settings-controller.ts";

interface ProviderEditSession {
  index: number;
  originKey?: string;
  currentKey: string;
  baseline?: ModelsProviderDraft;
  baselineRevision?: string;
  isNew: boolean;
  hasChanges: boolean;
}

function findProviderIndex(providers: ModelsProviderDraft[], session: ProviderEditSession): number | undefined {
  if (session.originKey !== undefined) {
    const originIndex = providers.findIndex((provider) => provider.origin?.providerKey === session.originKey);
    if (originIndex >= 0) return originIndex;
  }

  const indexedProvider = providers[session.index];
  if (indexedProvider?.key === session.currentKey) return session.index;

  const keyIndex = providers.findIndex((provider) => provider.key === session.currentKey);
  return keyIndex >= 0 ? keyIndex : undefined;
}

/** Session-independent structured editor for the global Pi models.json file. */
export function ModelsSettingsPage() {
  const controller = useModelsSettingsController();
  const [providerEdit, setProviderEdit] = useState<ProviderEditSession>();
  const providerEditRef = useRef<ProviderEditSession | undefined>(undefined);
  const selectedProvider =
    controller.selectedProviderIndex === undefined ? undefined : controller.draft[controller.selectedProviderIndex];
  const editorProviderIndex = providerEdit ? findProviderIndex(controller.draft, providerEdit) : undefined;
  const editorProvider = editorProviderIndex === undefined ? undefined : controller.draft[editorProviderIndex];
  const canSave = controller.dirty && controller.diagnostics.length === 0 && controller.status !== "saving";

  function setProviderEditSession(next: ProviderEditSession | undefined): void {
    providerEditRef.current = next;
    setProviderEdit(next);
  }

  function openProviderEditor(
    provider: ModelsProviderDraft | undefined,
    index: number | undefined,
    isNew = false,
  ): void {
    if (!provider || index === undefined) return;
    const current = providerEditRef.current;
    if (current) cancelProviderEditor();
    setProviderEditSession({
      index,
      originKey: provider.origin?.providerKey,
      currentKey: provider.key,
      baseline: isNew ? undefined : structuredClone(provider),
      baselineRevision: controller.snapshot?.revision,
      isNew,
      hasChanges: false,
    });
  }

  function updateProviderEditor(nextProvider: ModelsProviderDraft): void {
    const session = providerEditRef.current;
    if (!session) return;

    const currentIndex = findProviderIndex(controller.draft, session);
    const currentProvider = currentIndex === undefined ? undefined : controller.draft[currentIndex];
    if (currentIndex === undefined) return;
    if (session.baselineRevision !== controller.snapshot?.revision) {
      if (currentProvider && !controller.dirty) {
        setProviderEditSession({
          ...session,
          baseline: structuredClone(currentProvider),
          baselineRevision: controller.snapshot?.revision,
          hasChanges: false,
        });
      }
      return;
    }

    controller.mutate((providers) => {
      const targetIndex = findProviderIndex(providers, session);
      if (targetIndex !== undefined) providers[targetIndex] = structuredClone(nextProvider);
    });
    session.currentKey = nextProvider.key;
    session.hasChanges = session.isNew || !session.baseline || !modelsDraftsEqual([nextProvider], [session.baseline]);
    setProviderEditSession({ ...session });
  }

  function finishProviderEditor(): void {
    setProviderEditSession(undefined);
  }

  function cancelProviderEditor(): void {
    const session = providerEditRef.current;
    if (!session) return;
    const currentIndex = findProviderIndex(controller.draft, session);
    if (currentIndex !== undefined) {
      if (session.isNew) {
        const remainingCount = controller.draft.length - 1;
        controller.mutate((providers) => {
          const targetIndex = findProviderIndex(providers, session);
          if (targetIndex !== undefined) providers.splice(targetIndex, 1);
        });
        controller.selectProvider(remainingCount > 0 ? Math.min(currentIndex, remainingCount - 1) : undefined);
      } else if (session.baseline) {
        const baseline = session.baseline;
        controller.mutate((providers) => {
          const targetIndex = findProviderIndex(providers, session);
          if (targetIndex !== undefined) providers[targetIndex] = structuredClone(baseline);
        });
      }
    }
    setProviderEditSession(undefined);
  }

  function deleteProviderEditor(): void {
    const session = providerEditRef.current;
    if (!session) return;
    const currentIndex = findProviderIndex(controller.draft, session);
    if (currentIndex === undefined) {
      setProviderEditSession(undefined);
      return;
    }
    const remainingCount = controller.draft.length - 1;
    controller.mutate((providers) => {
      const targetIndex = findProviderIndex(providers, session);
      if (targetIndex !== undefined) providers.splice(targetIndex, 1);
    });
    controller.selectProvider(remainingCount > 0 ? Math.min(currentIndex, remainingCount - 1) : undefined);
    setProviderEditSession(undefined);
  }

  useEffect(() => {
    const session = providerEditRef.current;
    if (!session || session.baselineRevision === controller.snapshot?.revision) return;
    if (!editorProvider) {
      if (!session.isNew) setProviderEditSession(undefined);
      return;
    }
    if (controller.dirty && session.hasChanges) return;
    setProviderEditSession({
      ...session,
      index: editorProviderIndex ?? session.index,
      originKey: editorProvider.origin?.providerKey,
      currentKey: editorProvider.key,
      baseline: structuredClone(editorProvider),
      baselineRevision: controller.snapshot?.revision,
      isNew: false,
      hasChanges: false,
    });
  }, [controller.dirty, controller.snapshot?.revision, editorProvider, editorProviderIndex, providerEdit]);

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
                openProviderEditor(controller.draft[existingIndex], existingIndex);
                return;
              }
              const nextIndex = controller.draft.length;
              const builtIn = controller.snapshot?.metadata.builtInProviders.find((provider) => provider.id === key);
              const draft = createProviderDraft(key);
              if (builtIn) {
                draft.config = {
                  name: builtIn.displayName,
                  api: builtIn.models[0]?.api,
                };
              }
              controller.mutate((providers) => providers.push(draft));
              controller.selectProvider(nextIndex);
              openProviderEditor(draft, nextIndex, true);
            }}
          />
          <main className="models-detail-pane">
            {selectedProvider ? (
              <ModelsProviderOverview
                provider={selectedProvider}
                metadata={controller.snapshot.metadata}
                onEdit={() => openProviderEditor(selectedProvider, controller.selectedProviderIndex)}
              />
            ) : (
              <div className="models-empty-detail">
                <div className="models-empty-icon">
                  <Plus />
                </div>
                <h3>添加一个模型 Provider</h3>
                <p>从左侧选择内置服务，或添加自定义兼容接口。</p>
              </div>
            )}
          </main>
        </div>
      ) : null}

      {editorProvider && controller.snapshot ? (
        <Dialog
          open={providerEdit !== undefined}
          onOpenChange={(open) => {
            if (!open) cancelProviderEditor();
          }}
        >
          <DialogContent className="models-editor-dialog" style={{ width: "90vw", maxWidth: "80rem" }}>
            <DialogHeader>
              <DialogTitle>编辑 Provider</DialogTitle>
              <DialogDescription>修改连接信息、模型和兼容性选项。</DialogDescription>
            </DialogHeader>
            <div className="models-editor-dialog-body">
              <ModelsProviderForm
                provider={editorProvider}
                metadata={controller.snapshot.metadata}
                onChange={updateProviderEditor}
                onDelete={deleteProviderEditor}
              />
            </div>
            <DialogFooter className="models-editor-dialog-footer">
              <DialogClose asChild>
                <Button onClick={finishProviderEditor}>完成</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
