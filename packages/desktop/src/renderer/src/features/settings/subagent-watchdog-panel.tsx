import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Button } from "@renderer/shared/ui/button";
import { type FormEvent, useMemo, useState } from "react";
import type { ThinkingLevel } from "../../../../shared/contracts.ts";
import type {
  SubagentModelOption,
  SubagentWatchdogConfigInput,
  SubagentWatchdogSettings,
} from "../../../../shared/subagent-contracts.ts";
import { getThinkingLevelLabel } from "../../shared/lib/thinking-level-label.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";
import { SubagentModelSelectOptions } from "./subagent-model-select-options.tsx";

const INHERIT_VALUE = "inherit";
const ENABLED_VALUE = "enabled";
const DISABLED_VALUE = "disabled";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface SubagentWatchdogPanelProps {
  settings: SubagentWatchdogSettings;
  models: SubagentModelOption[];
  scopeLabel: string;
  saving: boolean;
  onSave(config: SubagentWatchdogConfigInput): Promise<boolean>;
}

export function SubagentWatchdogPanel({ settings, models, scopeLabel, saving, onSave }: SubagentWatchdogPanelProps) {
  const [globalEnabled, setGlobalEnabled] = useState(() => booleanOverrideValue(settings.override.enabled));
  const [mainEnabled, setMainEnabled] = useState(() => booleanOverrideValue(settings.override.main.enabled));
  const [mainModel, setMainModel] = useState(settings.override.main.model ?? INHERIT_VALUE);
  const [mainThinking, setMainThinking] = useState(() => thinkingOverrideValue(settings.override.main.thinking));
  const [childrenEnabled, setChildrenEnabled] = useState(() =>
    booleanOverrideValue(settings.override.children.enabled),
  );
  const [childrenModel, setChildrenModel] = useState(settings.override.children.model ?? INHERIT_VALUE);
  const [childrenThinking, setChildrenThinking] = useState(() =>
    thinkingOverrideValue(settings.override.children.thinking),
  );
  const modelOptions = useMemo(() => {
    const missingModels = [
      settings.effective.main.model,
      settings.effective.children.model,
      settings.inherited.main.model,
      settings.inherited.children.model,
    ].flatMap((model) =>
      model && !models.some(({ id }) => id === model)
        ? [
            {
              id: model,
              provider: model.split("/", 1)[0] ?? "",
              name: model,
              reasoning: true,
              thinkingLevels: [] as ThinkingLevel[],
            },
          ]
        : [],
    );
    return [...new Map([...missingModels, ...models].map((model) => [model.id, model])).values()];
  }, [
    models,
    settings.effective.children.model,
    settings.effective.main.model,
    settings.inherited.children.model,
    settings.inherited.main.model,
  ]);
  const mainThinkingLabel = effectiveThinkingLabel(settings.inherited.main.thinking);
  const childrenThinkingLabel = effectiveThinkingLabel(settings.inherited.children.thinking);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onSave({
      enabled: booleanOverride(globalEnabled),
      main: {
        enabled: booleanOverride(mainEnabled),
        model: optionalStringOverride(mainModel),
        thinking: thinkingOverride(mainThinking),
      },
      children: {
        enabled: booleanOverride(childrenEnabled),
        model: optionalStringOverride(childrenModel),
        thinking: thinkingOverride(childrenThinking),
      },
    });
  }

  return (
    <section className="settings-section subagent-section" aria-labelledby="subagent-watchdog-heading">
      <div className="settings-section-heading subagent-section-heading">
        <h3 id="subagent-watchdog-heading">自动审查</h3>
        <span className="subagent-scope-badge">{scopeLabel}</span>
      </div>
      <form className="subagent-config-form" onSubmit={submit}>
        <div className="subagent-watchdog-group">
          <h4>全局</h4>
          <div className="subagent-form-grid">
            <SubagentFormField label="自动审查">
              {({ controlId, labelId }) => (
                <SelectRoot value={globalEnabled} onValueChange={setGlobalEnabled}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>
                      继承（{settings.inherited.enabled ? "启用" : "停用"}）
                    </SelectItem>
                    <SelectItem value={ENABLED_VALUE}>启用</SelectItem>
                    <SelectItem value={DISABLED_VALUE}>停用</SelectItem>
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
          </div>
        </div>
        <div className="subagent-watchdog-group">
          <h4>主会话</h4>
          <div className="subagent-form-grid">
            <SubagentFormField label="启用状态">
              {({ controlId, labelId }) => (
                <SelectRoot value={mainEnabled} onValueChange={setMainEnabled}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>
                      继承（{settings.inherited.main.enabled ? "启用" : "停用"}）
                    </SelectItem>
                    <SelectItem value={ENABLED_VALUE}>启用</SelectItem>
                    <SelectItem value={DISABLED_VALUE}>停用</SelectItem>
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
            <SubagentFormField label="审查模型">
              {({ controlId, labelId }) => (
                <SelectRoot value={mainModel} onValueChange={setMainModel}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>
                      继承（{settings.inherited.main.model ?? "当前会话模型"}）
                    </SelectItem>
                    <SubagentModelSelectOptions models={modelOptions} />
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
            <SubagentFormField label="思考级别">
              {({ controlId, labelId }) => (
                <SelectRoot value={mainThinking} onValueChange={setMainThinking}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>继承（{mainThinkingLabel}）</SelectItem>
                    {THINKING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {getThinkingLevelLabel(level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
          </div>
        </div>
        <div className="subagent-watchdog-group">
          <h4>子智能体</h4>
          <div className="subagent-form-grid">
            <SubagentFormField label="启用状态">
              {({ controlId, labelId }) => (
                <SelectRoot value={childrenEnabled} onValueChange={setChildrenEnabled}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>
                      继承（{settings.inherited.children.enabled ? "启用" : "停用"}）
                    </SelectItem>
                    <SelectItem value={ENABLED_VALUE}>启用</SelectItem>
                    <SelectItem value={DISABLED_VALUE}>停用</SelectItem>
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
            <SubagentFormField label="审查模型">
              {({ controlId, labelId }) => (
                <SelectRoot value={childrenModel} onValueChange={setChildrenModel}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>
                      继承（{settings.inherited.children.model ?? "当前会话模型"}）
                    </SelectItem>
                    <SubagentModelSelectOptions models={modelOptions} />
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
            <SubagentFormField label="思考级别">
              {({ controlId, labelId }) => (
                <SelectRoot value={childrenThinking} onValueChange={setChildrenThinking}>
                  <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>继承（{childrenThinkingLabel}）</SelectItem>
                    {THINKING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {getThinkingLevelLabel(level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              )}
            </SubagentFormField>
          </div>
        </div>
        <div className="subagent-config-actions">
          <Button type="submit" disabled={saving}>
            保存自动审查
          </Button>
        </div>
      </form>
    </section>
  );
}

function booleanOverrideValue(value: boolean | undefined): string {
  return value === undefined ? INHERIT_VALUE : value ? ENABLED_VALUE : DISABLED_VALUE;
}

function booleanOverride(value: string): boolean | null {
  return value === INHERIT_VALUE ? null : value === ENABLED_VALUE;
}

function thinkingOverrideValue(value: ThinkingLevel | false | undefined): string {
  if (value === undefined) return INHERIT_VALUE;
  return value === false ? "off" : value;
}

function thinkingOverride(value: string): ThinkingLevel | null {
  return value === INHERIT_VALUE ? null : (value as ThinkingLevel);
}

function optionalStringOverride(value: string): string | null {
  return value === INHERIT_VALUE ? null : value;
}

function effectiveThinkingLabel(value: ThinkingLevel | false | undefined): string {
  return getThinkingLevelLabel(value === false ? "off" : (value ?? "off"));
}
