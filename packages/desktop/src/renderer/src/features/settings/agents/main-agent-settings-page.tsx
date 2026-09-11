import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import { Textarea } from "@renderer/shared/ui/textarea";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Star from "lucide-react/dist/esm/icons/star.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useState } from "react";
import type { MainAgentPromptMode } from "../../../../../shared/main-agent-contracts.ts";
import { useMainAgentSettingsController } from "./use-main-agent-settings-controller.ts";

const NEW_AGENT_TAB = "__new-agent__";

const PROMPT_MODES: Array<{ value: MainAgentPromptMode; label: string }> = [
  { value: "default", label: "系统默认" },
  { value: "append", label: "追加" },
  { value: "replace", label: "完全替换基础提示词" },
];

function statusText(status: ReturnType<typeof useMainAgentSettingsController>["status"], dirty: boolean): string {
  if (status === "loading") return "加载中…";
  if (status === "saving") return "保存中…";
  if (status === "saved") return "已保存";
  if (status === "conflict") return "检测到配置冲突";
  if (status === "error") return "操作失败";
  return dirty ? "有未保存的修改" : "用户级配置";
}

export function MainAgentSettingsPage() {
  const controller = useMainAgentSettingsController();
  const [deleteId, setDeleteId] = useState<string>();
  const draft = controller.draft;
  const snapshot = controller.snapshot;
  const configuredTools = draft?.configuration.tools ?? null;
  const configuredPlugins = draft?.configuration.builtinPluginIds ?? null;
  const toolCatalog = (controller.catalog?.tools ?? []).filter((tool) => tool.source === "builtin");

  return (
    <>
      <div className="settings-content main-agent-settings">
        <header className="settings-page-heading">
          <div>
            <h2>智能体</h2>
            <span>{statusText(controller.status, controller.dirty)}</span>
          </div>
          <div className="settings-page-actions">
            <TooltipIconButton
              tooltip="重新载入"
              side="bottom"
              disabled={controller.busy || (controller.dirty && controller.status !== "conflict")}
              onClick={() => void controller.reload()}
            >
              <RefreshCw />
            </TooltipIconButton>
            <Button size="sm" disabled={controller.busy || controller.dirty} onClick={controller.create}>
              <Plus />
              新建智能体
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
        {controller.errors.length ? (
          <div className="settings-page-message" data-tone="error" role="alert">
            {controller.errors.join("；")}
          </div>
        ) : null}

        {controller.status === "loading" || !snapshot || !draft ? (
          <div className="settings-loading" aria-label="加载智能体设置" />
        ) : (
          <Tabs
            className="main-agent-workspace"
            value={draft.id ?? NEW_AGENT_TAB}
            onValueChange={(id) => {
              if (id !== NEW_AGENT_TAB) controller.select(id);
            }}
          >
            <TabsList className="main-agent-list" aria-label="智能体列表">
              {snapshot.profiles.map((profile) => (
                <TabsTrigger
                  key={profile.id}
                  value={profile.id}
                  className="main-agent-list-item"
                  disabled={controller.dirty && draft.id !== profile.id}
                >
                  <strong>{profile.name}</strong>
                  {profile.id === snapshot.defaultAgentId ? <Star aria-label="新会话默认" /> : null}
                </TabsTrigger>
              ))}
              {draft.id === null ? (
                <TabsTrigger value={NEW_AGENT_TAB} className="main-agent-list-item">
                  <strong>{draft.name || "新建智能体"}</strong>
                </TabsTrigger>
              ) : null}
            </TabsList>

            <TabsContent value={draft.id ?? NEW_AGENT_TAB} asChild>
              <main className="main-agent-editor">
                <section className="settings-section" aria-labelledby="main-agent-basic-heading">
                  <div className="settings-section-heading main-agent-section-heading">
                    <div>
                      <h3 id="main-agent-basic-heading">{draft.id === null ? "新建智能体" : draft.name}</h3>
                      <p className="settings-row-description">
                        {draft.builtin ? "内置条目可编辑和恢复，但不能删除" : "仅影响使用此配置创建的新会话"}
                      </p>
                    </div>
                    {draft.id ? (
                      <div className="main-agent-inline-actions">
                        <TooltipIconButton
                          tooltip="复制智能体"
                          disabled={controller.busy || controller.dirty}
                          onClick={() => void controller.duplicate(draft.id!)}
                        >
                          <Copy />
                        </TooltipIconButton>
                        {snapshot.defaultAgentId !== draft.id ? (
                          <TooltipIconButton
                            tooltip="设为新会话默认"
                            disabled={controller.busy || controller.dirty}
                            onClick={() => void controller.setDefault(draft.id!)}
                          >
                            <Star />
                          </TooltipIconButton>
                        ) : null}
                        {draft.builtin ? (
                          <TooltipIconButton
                            tooltip="恢复内置默认配置"
                            disabled={controller.busy || controller.dirty}
                            onClick={() => void controller.resetBuiltin()}
                          >
                            <RotateCcw />
                          </TooltipIconButton>
                        ) : (
                          <TooltipIconButton
                            tooltip="删除智能体"
                            disabled={controller.busy || controller.dirty}
                            onClick={() => setDeleteId(draft.id!)}
                          >
                            <Trash2 />
                          </TooltipIconButton>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <label className="main-agent-field">
                    <span>名称</span>
                    <Input
                      value={draft.name}
                      maxLength={80}
                      onChange={(event) =>
                        controller.mutateDraft((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                  </label>
                  <label className="main-agent-field">
                    <span>描述</span>
                    <Input
                      value={draft.description}
                      maxLength={500}
                      onChange={(event) =>
                        controller.mutateDraft((current) => ({ ...current, description: event.target.value }))
                      }
                    />
                  </label>
                </section>

                <section className="settings-section" aria-labelledby="main-agent-prompt-heading">
                  <div className="settings-section-heading">
                    <h3 id="main-agent-prompt-heading">系统提示词</h3>
                  </div>
                  <div className="main-agent-form-block">
                    <div className="settings-segmented-control main-agent-prompt-modes" aria-label="提示词模式">
                      {PROMPT_MODES.map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          className="settings-segmented-item"
                          data-state={draft.configuration.prompt.mode === mode.value ? "checked" : undefined}
                          onClick={() =>
                            controller.mutateDraft((current) => ({
                              ...current,
                              configuration: {
                                ...current.configuration,
                                prompt: { ...current.configuration.prompt, mode: mode.value },
                              },
                            }))
                          }
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <label>
                      <span>用户提示词（按字面文本使用，不读取路径）</span>
                      <Textarea
                        value={draft.configuration.prompt.text}
                        onChange={(event) =>
                          controller.mutateDraft((current) => ({
                            ...current,
                            configuration: {
                              ...current.configuration,
                              prompt: { ...current.configuration.prompt, text: event.target.value },
                            },
                          }))
                        }
                      />
                    </label>
                    <div className="main-agent-checkboxes" aria-label="额外上下文来源">
                      {[
                        ["includeGlobalRules", "加载全局规则"],
                        ["includeProjectRules", "加载项目规则"],
                        ["includeSkills", "提供技能目录"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          <Checkbox
                            checked={
                              draft.configuration.prompt[key as keyof typeof draft.configuration.prompt] === true
                            }
                            onCheckedChange={(checked) =>
                              controller.mutateDraft((current) => ({
                                ...current,
                                configuration: {
                                  ...current.configuration,
                                  prompt: { ...current.configuration.prompt, [key]: checked === true },
                                },
                              }))
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <p className="settings-row-description">
                      插件动态上下文和运行目录仍可能在发送时加入；完全替换仅替换基础提示词和自动发现的 SYSTEM / APPEND
                      内容。
                    </p>
                  </div>
                </section>

                <section className="settings-section" aria-labelledby="main-agent-tools-heading">
                  <div className="settings-section-heading">
                    <div>
                      <h3 id="main-agent-tools-heading">基础工具</h3>
                      <p className="settings-row-description">仅选择主会话的基础工具；已启用插件的工具自动可用。</p>
                    </div>
                  </div>
                  <div className="main-agent-form-block">
                    <div className="settings-segmented-control" aria-label="工具选择模式">
                      <button
                        type="button"
                        className="settings-segmented-item"
                        data-state={configuredTools === null ? "checked" : undefined}
                        onClick={() =>
                          controller.mutateDraft((current) => ({
                            ...current,
                            configuration: { ...current.configuration, tools: null },
                          }))
                        }
                      >
                        使用系统默认
                      </button>
                      <button
                        type="button"
                        className="settings-segmented-item"
                        data-state={configuredTools !== null ? "checked" : undefined}
                        onClick={() =>
                          controller.mutateDraft((current) => ({
                            ...current,
                            configuration: { ...current.configuration, tools: current.configuration.tools ?? [] },
                          }))
                        }
                      >
                        自定义选择
                      </button>
                    </div>
                    {configuredTools !== null ? (
                      <div className="main-agent-option-list">
                        {toolCatalog.map((tool) => (
                          <label key={tool.id} data-unavailable={!tool.available || undefined}>
                            <Checkbox
                              checked={configuredTools.includes(tool.id)}
                              onCheckedChange={(checked) =>
                                controller.mutateDraft((current) => ({
                                  ...current,
                                  configuration: {
                                    ...current.configuration,
                                    tools:
                                      checked === true
                                        ? [...(current.configuration.tools ?? []), tool.id]
                                        : (current.configuration.tools ?? []).filter((id) => id !== tool.id),
                                  },
                                }))
                              }
                            />
                            <span>
                              <strong>{tool.name}</strong>
                              <small>
                                {tool.source === "builtin" ? "基础工具" : "扩展工具"}
                                {!tool.available ? ` · ${tool.reason ?? "当前不可用"}` : ""}
                              </small>
                            </span>
                          </label>
                        ))}
                        <p className="settings-row-description">不勾选时关闭所有基础工具，已启用插件的工具仍然可用。</p>
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="settings-section" aria-labelledby="main-agent-plugins-heading">
                  <div className="settings-section-heading">
                    <div>
                      <h3 id="main-agent-plugins-heading">内置功能</h3>
                      <p className="settings-row-description">配置为启用与当前实际可用分别显示</p>
                    </div>
                  </div>
                  <div className="main-agent-form-block">
                    <div className="settings-segmented-control" aria-label="内置功能选择模式">
                      <button
                        type="button"
                        className="settings-segmented-item"
                        data-state={configuredPlugins === null ? "checked" : undefined}
                        onClick={() =>
                          controller.mutateDraft((current) => ({
                            ...current,
                            configuration: { ...current.configuration, builtinPluginIds: null },
                          }))
                        }
                      >
                        使用 Desktop 默认
                      </button>
                      <button
                        type="button"
                        className="settings-segmented-item"
                        data-state={configuredPlugins !== null ? "checked" : undefined}
                        onClick={() =>
                          controller.mutateDraft((current) => ({
                            ...current,
                            configuration: {
                              ...current.configuration,
                              builtinPluginIds: current.configuration.builtinPluginIds ?? [],
                            },
                          }))
                        }
                      >
                        自定义选择
                      </button>
                    </div>
                    {configuredPlugins !== null ? (
                      <div className="main-agent-option-list">
                        {(controller.catalog?.builtinPlugins ?? []).map((plugin) => (
                          <label key={plugin.id} data-unavailable={!plugin.available || undefined}>
                            <Checkbox
                              checked={configuredPlugins.includes(plugin.id)}
                              disabled={!plugin.available && !configuredPlugins.includes(plugin.id)}
                              onCheckedChange={(checked) =>
                                controller.mutateDraft((current) => ({
                                  ...current,
                                  configuration: {
                                    ...current.configuration,
                                    builtinPluginIds:
                                      checked === true
                                        ? [...(current.configuration.builtinPluginIds ?? []), plugin.id]
                                        : (current.configuration.builtinPluginIds ?? []).filter(
                                            (id) => id !== plugin.id,
                                          ),
                                  },
                                }))
                              }
                            />
                            <span>
                              <strong>{plugin.name}</strong>
                              <small>{plugin.available ? plugin.description : (plugin.reason ?? "当前不可用")}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>

                <div className="main-agent-save-actions">
                  {controller.dirty ? (
                    <Button variant="ghost" disabled={controller.busy} onClick={controller.discardDraft}>
                      放弃修改
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!controller.dirty || controller.errors.length > 0 || controller.busy}
                    onClick={() => void controller.save()}
                  >
                    <Save />
                    {draft.id === null ? "创建智能体" : "保存"}
                  </Button>
                </div>
              </main>
            </TabsContent>
          </Tabs>
        )}
      </div>

      <ConfirmDialog
        open={deleteId !== undefined}
        title="删除此智能体？"
        description="已有会话保留创建时的配置快照；此操作只影响后续选择。"
        onOpenChange={(open) => {
          if (!open) setDeleteId(undefined);
        }}
        onConfirm={async () => {
          if (!deleteId) return;
          const removed = await controller.remove(deleteId);
          if (!removed) throw new Error("删除失败");
          setDeleteId(undefined);
        }}
      />
      <ConfirmDialog
        open={controller.routeBlocked}
        title="放弃未保存的智能体设置？"
        description="离开此页面会丢失当前配置修改。"
        confirmLabel="放弃并离开"
        onCancel={controller.cancelRouteChange}
        onConfirm={controller.discardAndProceed}
      />
    </>
  );
}
