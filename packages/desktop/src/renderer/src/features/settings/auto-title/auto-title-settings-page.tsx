import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import {
  AUTO_TITLE_MAX_LENGTH_MAX,
  DEFAULT_AUTO_TITLE_SYSTEM_PROMPT,
} from "../../../../../shared/auto-title-contracts.ts";
import { TitleModelSelect } from "./title-model-select.tsx";
import { type AutoTitleSettingsStatus, useAutoTitleSettingsController } from "./use-auto-title-settings-controller.ts";

function statusText(status: AutoTitleSettingsStatus, dirty: boolean): string {
  switch (status) {
    case "loading":
      return "加载中…";
    case "saving":
      return "保存中…";
    case "saved":
      return "已保存";
    case "conflict":
      return "冲突，请重新载入";
    case "error":
      return "加载失败";
    case "dirty":
      return dirty ? "有未保存的修改" : "已就绪";
    default:
      return "已就绪";
  }
}

export function AutoTitleSettingsPage() {
  const controller = useAutoTitleSettingsController();
  const draft = controller.draft;
  const busy = controller.status === "loading" || controller.status === "saving";
  const canSave = controller.dirty && controller.errors.length === 0 && !busy;

  return (
    <>
      <div className="settings-content">
        <header className="settings-page-heading">
          <div>
            <h2>自动标题</h2>
            <span>{statusText(controller.status, controller.dirty)}</span>
          </div>
          <div className="settings-page-actions">
            <TooltipIconButton
              tooltip="重新载入"
              side="bottom"
              disabled={busy || (controller.dirty && controller.status !== "conflict")}
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
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.error}
          </div>
        ) : null}
        {controller.notice ? (
          <div className="settings-page-message" data-tone="success" role="status">
            {controller.notice}
          </div>
        ) : null}
        {controller.errors.length > 0 ? (
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.errors.join("；")}
          </div>
        ) : null}

        {controller.status === "loading" || !draft ? (
          <div className="settings-loading" aria-label="加载自动标题设置" />
        ) : (
          <>
            <section className="settings-section" aria-labelledby="auto-title-general-heading">
              <div className="settings-section-heading">
                <h3 id="auto-title-general-heading">通用</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>启用自动标题</span>
                  <p className="settings-row-description">
                    首条有效消息先生成临时标题，第三条有效消息后再结合当前对话异步优化，不阻塞对话
                  </p>
                </div>
                <Switch
                  aria-label="启用自动标题"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => controller.mutateSettings({ enabled })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>标题模型</span>
                  <p className="settings-row-description">从已配置的模型服务商中选择；不选则使用当前会话模型</p>
                </div>
                <TitleModelSelect
                  providerId={draft.providerId}
                  modelId={draft.modelId}
                  options={controller.modelOptions}
                  onChange={(providerId, modelId) => controller.mutateSettings({ providerId, modelId })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>标题最大长度</span>
                  <p className="settings-row-description">
                    生成结果超过该长度时截断，范围 1 到 {AUTO_TITLE_MAX_LENGTH_MAX}
                  </p>
                </div>
                <Input
                  className="w-30"
                  aria-label="标题最大长度"
                  type="number"
                  min={1}
                  max={AUTO_TITLE_MAX_LENGTH_MAX}
                  value={draft.maxLength}
                  onChange={(event) => controller.mutateSettings({ maxLength: Number(event.target.value) })}
                />
              </div>
            </section>

            <section className="settings-section" aria-labelledby="auto-title-prompt-heading">
              <div className="settings-section-heading">
                <h3 id="auto-title-prompt-heading">提示词</h3>
              </div>
              <div className="settings-textarea-row">
                <label htmlFor="auto-title-system-prompt">发送给大模型的系统提示词</label>
                <Textarea
                  id="auto-title-system-prompt"
                  value={draft.systemPrompt}
                  onChange={(event) => controller.mutateSettings({ systemPrompt: event.target.value })}
                />
                <p className="settings-row-description">留空时使用默认提示词：{DEFAULT_AUTO_TITLE_SYSTEM_PROMPT}</p>
              </div>
            </section>
          </>
        )}
      </div>
      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的自动标题设置？"
        description="离开此页面会丢失当前配置修改。"
        confirmLabel="放弃并离开"
        onCancel={controller.cancelRouteChange}
        onConfirm={controller.discardAndProceed}
      />
    </>
  );
}
