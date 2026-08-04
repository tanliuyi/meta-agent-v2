import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { type FormEvent, useState } from "react";
import type { SubagentExtensionConfig } from "../../../../../shared/subagent-contracts.ts";

interface SubagentExtensionConfigPanelProps {
  config: SubagentExtensionConfig;
  saving: boolean;
  onSave(config: Partial<SubagentExtensionConfig>): Promise<boolean>;
}

export function SubagentExtensionConfigPanel({ config, saving, onSave }: SubagentExtensionConfigPanelProps) {
  const [draft, setDraft] = useState({
    asyncByDefault: config.asyncByDefault ?? false,
    asyncWidget: config.asyncWidget ?? true,
    maxSubagentDepth: config.maxSubagentDepth ?? 1,
    maxSubagentSpawnsPerSession: config.maxSubagentSpawnsPerSession ?? 0,
    globalConcurrencyLimit: config.globalConcurrencyLimit ?? 20,
    toolDescriptionMode: config.toolDescriptionMode ?? "full",
    artifactDir: config.artifactDir ?? "project",
    scheduledRunsEnabled: config.scheduledRuns?.enabled ?? false,
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onSave({
      asyncByDefault: draft.asyncByDefault,
      asyncWidget: draft.asyncWidget,
      maxSubagentDepth: draft.maxSubagentDepth,
      maxSubagentSpawnsPerSession: draft.maxSubagentSpawnsPerSession,
      globalConcurrencyLimit: draft.globalConcurrencyLimit,
      toolDescriptionMode: draft.toolDescriptionMode,
      artifactDir: draft.artifactDir,
      scheduledRuns: { ...config.scheduledRuns, enabled: draft.scheduledRunsEnabled },
    });
  }

  return (
    <details className="settings-section subagent-section subagent-config-panel">
      <summary className="settings-section-heading subagent-config-summary">
        <h3>全局配置</h3>
        <ChevronDown />
      </summary>
      <form className="subagent-config-form" onSubmit={submit}>
        <div className="settings-row subagent-config-row">
          <span>默认异步执行</span>
          <Switch
            aria-label="默认异步执行"
            checked={draft.asyncByDefault}
            onCheckedChange={(checked) => setDraft((current) => ({ ...current, asyncByDefault: checked }))}
          />
        </div>
        <div className="settings-row subagent-config-row">
          <span>显示异步运行面板</span>
          <Switch
            aria-label="显示异步运行面板"
            checked={draft.asyncWidget}
            onCheckedChange={(checked) => setDraft((current) => ({ ...current, asyncWidget: checked }))}
          />
        </div>
        <div className="settings-row subagent-config-row">
          <span>最大嵌套深度</span>
          <Input
            aria-label="最大嵌套深度"
            type="number"
            min={0}
            value={draft.maxSubagentDepth}
            className="w-60"
            onChange={(event) => setDraft((current) => ({ ...current, maxSubagentDepth: Number(event.target.value) }))}
          />
        </div>
        <div className="settings-row subagent-config-row">
          <span>每会话最大生成数</span>
          <Input
            aria-label="每会话最大生成数"
            type="number"
            min={0}
            value={draft.maxSubagentSpawnsPerSession}
            className="w-60"
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxSubagentSpawnsPerSession: Number(event.target.value) }))
            }
          />
        </div>
        <div className="settings-row subagent-config-row">
          <span>全局并行上限</span>
          <Input
            aria-label="全局并行上限"
            type="number"
            min={1}
            value={draft.globalConcurrencyLimit}
            className="w-60"
            onChange={(event) =>
              setDraft((current) => ({ ...current, globalConcurrencyLimit: Number(event.target.value) }))
            }
          />
        </div>
        <div className="settings-row subagent-config-row">
          <span>工具描述模式</span>
          <SelectRoot
            value={draft.toolDescriptionMode}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                toolDescriptionMode: value as NonNullable<SubagentExtensionConfig["toolDescriptionMode"]>,
              }))
            }
          >
            <SelectTrigger className="w-60" aria-label="工具描述模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">完整</SelectItem>
              <SelectItem value="compact">精简</SelectItem>
              {config.toolDescriptionMode === "custom" ? <SelectItem value="custom">自定义</SelectItem> : null}
            </SelectContent>
          </SelectRoot>
        </div>
        <div className="settings-row subagent-config-row">
          <span>产物目录</span>
          <SelectRoot
            value={draft.artifactDir}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                artifactDir: value as NonNullable<SubagentExtensionConfig["artifactDir"]>,
              }))
            }
          >
            <SelectTrigger className="w-60" aria-label="产物目录">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">项目目录</SelectItem>
              <SelectItem value="session">会话目录</SelectItem>
              <SelectItem value="temp">临时目录</SelectItem>
            </SelectContent>
          </SelectRoot>
        </div>
        <div className="settings-row subagent-config-row">
          <span>定时运行</span>
          <Switch
            aria-label="定时运行"
            checked={draft.scheduledRunsEnabled}
            onCheckedChange={(checked) => setDraft((current) => ({ ...current, scheduledRunsEnabled: checked }))}
          />
        </div>
        <div className="subagent-config-actions">
          <Button type="submit" disabled={saving}>
            保存全局配置
          </Button>
        </div>
      </form>
    </details>
  );
}
