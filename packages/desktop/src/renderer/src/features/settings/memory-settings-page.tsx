import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import { Textarea } from "@renderer/shared/ui/textarea";
import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import Database from "lucide-react/dist/esm/icons/database.mjs";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Wrench from "lucide-react/dist/esm/icons/wrench.mjs";
import { useRef } from "react";
import type {
  MemoryEntryTarget,
  MemoryOverflowStrategy,
  MemoryPolicyStyle,
  MemoryPromptMode,
  MemorySessionSearchVariant,
} from "../../../../shared/memory-settings-contracts.ts";
import { MemorySettingsDialogs, type MemorySettingsDialogsHandle } from "./memory-settings-dialogs.tsx";
import { useMemorySettingsController } from "./use-memory-settings-controller.ts";

export function MemorySettingsPage() {
  const controller = useMemorySettingsController();
  const dialogsRef = useRef<MemorySettingsDialogsHandle>(null);
  const draft = controller.draft;
  const snapshot = controller.snapshot;
  const busy = controller.status === "loading" || controller.status === "saving" || controller.status === "working";
  const canSave = controller.dirty && controller.errors.length === 0 && !busy;
  const globalCollections = snapshot?.collections.filter(({ target }) => target !== "project") ?? [];
  const projectCollections = snapshot?.collections.filter(({ target }) => target === "project") ?? [];

  return (
    <div className="settings-content memory-settings">
      <header className="settings-page-heading memory-page-heading">
        <div>
          <h2>记忆</h2>
          <span>{statusText(controller.status, controller.dirty)}</span>
        </div>
        <div className="memory-page-actions">
          <TooltipIconButton
            tooltip="重新载入"
            side="bottom"
            disabled={busy || controller.dirty}
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
        <div className="memory-page-message" data-tone="error" role="alert">
          {controller.error}
        </div>
      ) : null}
      {controller.notice ? (
        <div className="memory-page-message" data-tone="success" role="status">
          {controller.notice}
        </div>
      ) : null}
      {controller.errors.length > 0 ? (
        <div className="memory-page-message" data-tone="error" role="alert">
          {controller.errors.join("；")}
        </div>
      ) : null}

      {controller.status === "loading" || !draft || !snapshot ? (
        <div className="memory-loading" aria-label="加载记忆设置">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <Tabs className="memory-tabs" defaultValue="preferences">
          <TabsList className="memory-tab-list" aria-label="记忆设置视图">
            <TabsTrigger value="preferences">
              <Brain />
              偏好
            </TabsTrigger>
            <TabsTrigger value="entries">
              <Database />
              记忆内容
            </TabsTrigger>
            <TabsTrigger value="projects">
              <FolderKanban />
              项目与技能
            </TabsTrigger>
            <TabsTrigger value="maintenance">
              <Wrench />
              维护
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preferences" className="memory-tab-content">
            <section className="settings-section" aria-labelledby="memory-context-heading">
              <div className="settings-section-heading">
                <h3 id="memory-context-heading">上下文</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>提示模式</span>
                  <p className="settings-row-description">按需检索记忆，或将完整记忆注入每次对话</p>
                </div>
                <SelectRoot
                  value={draft.memoryMode}
                  onValueChange={(value) => controller.mutateSettings({ memoryMode: value as MemoryPromptMode })}
                >
                  <SelectTrigger className="memory-control" aria-label="提示模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="policy-only">按需检索</SelectItem>
                    <SelectItem value="legacy-inject">完整注入</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>记忆策略</span>
                  <p className="settings-row-description">控制按需检索模式写入系统提示的策略详细程度</p>
                </div>
                <SelectRoot
                  disabled={draft.memoryMode !== "policy-only"}
                  value={draft.memoryPolicyStyle}
                  onValueChange={(value) =>
                    controller.mutateSettings({ memoryPolicyStyle: value as MemoryPolicyStyle })
                  }
                >
                  <SelectTrigger className="memory-control" aria-label="记忆策略">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">完整</SelectItem>
                    <SelectItem value="compact">精简</SelectItem>
                    <SelectItem value="custom">自定义</SelectItem>
                    <SelectItem value="none">不注入策略</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
              {draft.memoryMode === "policy-only" && draft.memoryPolicyStyle === "custom" ? (
                <div className="memory-textarea-row">
                  <label htmlFor="memory-policy-custom-text">自定义策略文本</label>
                  <Textarea
                    id="memory-policy-custom-text"
                    value={draft.memoryPolicyCustomText}
                    onChange={(event) => controller.mutateSettings({ memoryPolicyCustomText: event.target.value })}
                  />
                </div>
              ) : null}
            </section>

            <section className="settings-section" aria-labelledby="memory-learning-heading">
              <div className="settings-section-heading">
                <h3 id="memory-learning-heading">自动学习</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>后台复盘</span>
                  <p className="settings-row-description">定期复盘对话并保存值得跨会话保留的信息</p>
                </div>
                <Switch
                  aria-label="后台复盘"
                  checked={draft.reviewEnabled}
                  onCheckedChange={(reviewEnabled) => controller.mutateSettings({ reviewEnabled })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>纠错学习</span>
                  <p className="settings-row-description">检测用户纠正并立即记录为长期记忆</p>
                </div>
                <Switch
                  aria-label="纠错学习"
                  checked={draft.correctionDetection}
                  onCheckedChange={(correctionDetection) => controller.mutateSettings({ correctionDetection })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>复盘间隔</span>
                  <p className="settings-row-description">达到任一阈值时触发后台复盘</p>
                </div>
                <div className="memory-number-group">
                  <label>
                    <span>对话轮数</span>
                    <Input
                      aria-label="复盘对话轮数"
                      type="number"
                      min={1}
                      value={draft.nudgeInterval}
                      onChange={(event) => controller.mutateSettings({ nudgeInterval: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>工具调用</span>
                    <Input
                      aria-label="复盘工具调用数"
                      type="number"
                      min={1}
                      value={draft.nudgeToolCalls}
                      onChange={(event) => controller.mutateSettings({ nudgeToolCalls: Number(event.target.value) })}
                    />
                  </label>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>压缩前写回</span>
                  <p className="settings-row-description">上下文压缩前保存当前会话中的长期信息</p>
                </div>
                <Switch
                  aria-label="压缩前写回"
                  checked={draft.flushOnCompact}
                  onCheckedChange={(flushOnCompact) => controller.mutateSettings({ flushOnCompact })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>退出时写回</span>
                  <p className="settings-row-description">会话关闭时保存尚未进入长期记忆的信息</p>
                </div>
                <Switch
                  aria-label="退出时写回"
                  checked={draft.flushOnShutdown}
                  onCheckedChange={(flushOnShutdown) => controller.mutateSettings({ flushOnShutdown })}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>写回最少轮数</span>
                  <p className="settings-row-description">低于该轮数的短会话不会触发写回</p>
                </div>
                <Input
                  className="w-22"
                  aria-label="写回最少轮数"
                  type="number"
                  min={0}
                  value={draft.flushMinTurns}
                  onChange={(event) => controller.mutateSettings({ flushMinTurns: Number(event.target.value) })}
                />
              </div>
            </section>

            <section className="settings-section" aria-labelledby="memory-capacity-heading">
              <div className="settings-section-heading">
                <h3 id="memory-capacity-heading">容量与检索</h3>
              </div>
              {(
                [
                  ["全局记忆", "memoryCharLimit", draft.memoryCharLimit],
                  ["用户资料", "userCharLimit", draft.userCharLimit],
                  ["项目记忆", "projectCharLimit", draft.projectCharLimit],
                ] as const
              ).map(([label, key, value]) => (
                <div className="settings-row" key={key}>
                  <div className="settings-row-text">
                    <span>{label}容量</span>
                    <p className="settings-row-description">Markdown 核心记忆的最大字符数</p>
                  </div>
                  <Input
                    className="w-22"
                    aria-label={`${label}容量`}
                    type="number"
                    min={1}
                    value={value}
                    onChange={(event) => controller.mutateSettings({ [key]: Number(event.target.value) })}
                  />
                </div>
              ))}
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>容量溢出</span>
                  <p className="settings-row-description">核心记忆达到上限时的处理方式</p>
                </div>
                <SelectRoot
                  value={draft.memoryOverflowStrategy}
                  onValueChange={(value) =>
                    controller.mutateSettings({ memoryOverflowStrategy: value as MemoryOverflowStrategy })
                  }
                >
                  <SelectTrigger className="memory-control" aria-label="容量溢出策略">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto-consolidate">自动整理</SelectItem>
                    <SelectItem value="fifo-evict">移除最早条目</SelectItem>
                    <SelectItem value="reject">拒绝写入</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>会话检索</span>
                  <p className="settings-row-description">选择 SQLite 摘要结果或 JSONL 行号锚点</p>
                </div>
                <SelectRoot
                  value={draft.sessionSearchVariant}
                  onValueChange={(value) =>
                    controller.mutateSettings({ sessionSearchVariant: value as MemorySessionSearchVariant })
                  }
                >
                  <SelectTrigger className="memory-control" aria-label="会话检索模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="legacy">SQLite 摘要</SelectItem>
                    <SelectItem value="anchors">文件锚点</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="entries" className="memory-tab-content">
            <Tabs className="memory-subtabs" defaultValue={globalCollections[0]?.target ?? "memory"}>
              <TabsList className="memory-subtab-list" aria-label="记忆内容范围">
                {globalCollections.map((collection) => (
                  <TabsTrigger value={collection.target} key={collection.target}>
                    {collectionTitle(collection.target)}
                  </TabsTrigger>
                ))}
              </TabsList>
              {globalCollections.map((collection) => (
                <TabsContent value={collection.target} className="memory-subtab-content" key={collection.target}>
                  <section className="settings-section" key={collection.target}>
                    <div className="settings-section-heading">
                      <div>
                        <h3>{collectionTitle(collection.target)}</h3>
                        <span className="memory-section-meta">
                          {collection.entries.length} 条 · {collection.charCount}/{collection.charLimit} 字符
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || controller.dirty}
                        onClick={() => dialogsRef.current?.openAdd(collection)}
                      >
                        <Plus />
                        新增
                      </Button>
                    </div>
                    {collection.entries.length > 0 ? (
                      collection.entries.map((entry) => (
                        <div className="settings-row memory-entry-row" key={entry.id}>
                          <button
                            type="button"
                            className="memory-entry-text"
                            disabled={busy || controller.dirty}
                            onClick={() => dialogsRef.current?.openReplace(collection, entry)}
                          >
                            {entry.content}
                          </button>
                          <div className="memory-entry-actions">
                            <TooltipIconButton
                              tooltip="编辑"
                              disabled={busy || controller.dirty}
                              onClick={() => dialogsRef.current?.openReplace(collection, entry)}
                            >
                              <Pencil />
                            </TooltipIconButton>
                            <TooltipIconButton
                              tooltip="删除"
                              disabled={busy || controller.dirty}
                              onClick={() =>
                                dialogsRef.current?.requestDelete({
                                  target: collection.target,
                                  projectId: collection.projectId,
                                  entryId: entry.id,
                                })
                              }
                            >
                              <Trash2 />
                            </TooltipIconButton>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="settings-row memory-empty-row">暂无内容</div>
                    )}
                  </section>
                </TabsContent>
              ))}
            </Tabs>
          </TabsContent>

          <TabsContent value="projects" className="memory-tab-content">
            <Tabs className="memory-subtabs" defaultValue={projectCollections[0]?.projectId ?? "skills"}>
              <TabsList className="memory-subtab-list" aria-label="项目与技能范围">
                {projectCollections.map((collection) => (
                  <TabsTrigger value={collection.projectId ?? ""} key={collection.projectId}>
                    {collection.projectName}
                  </TabsTrigger>
                ))}
                <TabsTrigger value="skills">流程技能</TabsTrigger>
              </TabsList>
              {projectCollections.map((collection) => (
                <TabsContent
                  value={collection.projectId ?? ""}
                  className="memory-subtab-content"
                  key={collection.projectId}
                >
                  <section className="settings-section" key={collection.projectId}>
                    <div className="settings-section-heading">
                      <div>
                        <h3>{collection.projectName}</h3>
                        <span className="memory-section-meta">
                          {collection.entries.length} 条 · {collection.charCount}/{collection.charLimit} 字符
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || controller.dirty}
                        onClick={() => dialogsRef.current?.openAdd(collection)}
                      >
                        <Plus />
                        新增
                      </Button>
                    </div>
                    {collection.entries.length > 0 ? (
                      collection.entries.map((entry) => (
                        <div className="settings-row memory-entry-row" key={entry.id}>
                          <button
                            type="button"
                            className="memory-entry-text"
                            disabled={busy || controller.dirty}
                            onClick={() => dialogsRef.current?.openReplace(collection, entry)}
                          >
                            {entry.content}
                          </button>
                          <div className="memory-entry-actions">
                            <TooltipIconButton
                              tooltip="编辑"
                              disabled={busy || controller.dirty}
                              onClick={() => dialogsRef.current?.openReplace(collection, entry)}
                            >
                              <Pencil />
                            </TooltipIconButton>
                            <TooltipIconButton
                              tooltip="删除"
                              disabled={busy || controller.dirty}
                              onClick={() =>
                                dialogsRef.current?.requestDelete({
                                  target: "project",
                                  projectId: collection.projectId,
                                  entryId: entry.id,
                                })
                              }
                            >
                              <Trash2 />
                            </TooltipIconButton>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="settings-row memory-empty-row">暂无项目记忆</div>
                    )}
                  </section>
                </TabsContent>
              ))}
              <TabsContent value="skills" className="memory-subtab-content">
                <section className="settings-section">
                  <div className="settings-section-heading">
                    <h3>流程技能</h3>
                    <span className="memory-section-meta">{snapshot.skills.length} 个</span>
                  </div>
                  {snapshot.skills.length > 0 ? (
                    snapshot.skills.map((skill) => (
                      <div className="settings-row memory-skill-row" key={skill.skillId}>
                        <div className="settings-row-text">
                          <span>{skill.displayName || skill.name}</span>
                          <p className="settings-row-description">{skill.description || "无描述"}</p>
                        </div>
                        <span className="memory-scope-badge">
                          {skill.scope === "global" ? "全局" : (skill.projectName ?? "项目")}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="settings-row memory-empty-row">暂无流程技能</div>
                  )}
                </section>
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="maintenance" className="memory-tab-content">
            <section className="settings-section">
              <div className="settings-section-heading">
                <h3>数据维护</h3>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>索引历史会话</span>
                  <p className="settings-row-description">将未进入搜索数据库的历史会话补充到索引</p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || controller.dirty}
                  onClick={() => void controller.runMaintenance("index-sessions")}
                >
                  <Database />
                  {controller.activeAction === "index-sessions" ? "索引中" : "开始索引"}
                </Button>
              </div>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span>同步 Markdown</span>
                  <p className="settings-row-description">用 Markdown 源文件修正 SQLite 记忆搜索镜像</p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || controller.dirty}
                  onClick={() => void controller.runMaintenance("sync-markdown")}
                >
                  <RefreshCw />
                  {controller.activeAction === "sync-markdown" ? "同步中" : "立即同步"}
                </Button>
              </div>
            </section>
            <section className="settings-section">
              <div className="settings-section-heading">
                <h3>注入上下文预览</h3>
              </div>
              <div className="memory-preview">
                <Textarea
                  aria-label="注入上下文预览"
                  readOnly
                  value={snapshot.contextPreview || "当前不注入记忆上下文"}
                />
              </div>
            </section>
          </TabsContent>
        </Tabs>
      )}

      <MemorySettingsDialogs ref={dialogsRef} controller={controller} busy={busy} />
    </div>
  );
}

function collectionTitle(target: MemoryEntryTarget): string {
  if (target === "user") return "用户资料";
  if (target === "failure") return "失败与纠错";
  if (target === "project") return "项目记忆";
  return "全局记忆";
}

function statusText(status: ReturnType<typeof useMemorySettingsController>["status"], dirty: boolean): string {
  if (status === "loading") return "加载中";
  if (status === "saving") return "保存中";
  if (status === "working") return "正在执行维护操作";
  if (status === "saved") return "已保存";
  if (status === "conflict") return "磁盘配置已改变";
  if (status === "error") return "操作失败";
  return dirty ? "有未保存修改" : "已同步";
}
