import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { Input } from "@renderer/shared/ui/input";
import { Textarea } from "@renderer/shared/ui/textarea";
import { type FormEvent, useCallback, useRef } from "react";
import type {
  AgentSummary,
  SubagentAgentConfigInput,
  SubagentModelOption,
  SubagentSettingsScope,
  SubagentSkillOption,
} from "../../../../shared/subagent-contracts.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";
import { SubagentModelField } from "./subagent-model-field.tsx";
import { SubagentSkillsField } from "./subagent-skills-field.tsx";
import { SubagentToggleField } from "./subagent-toggle-field.tsx";

interface SubagentAgentDialogProps {
  agent?: AgentSummary;
  builtin?: boolean;
  models: SubagentModelOption[];
  skills: SubagentSkillOption[];
  scope: SubagentSettingsScope;
  saving: boolean;
  onClose(): void;
  onSave(scope: SubagentSettingsScope, config: SubagentAgentConfigInput): Promise<boolean>;
}

interface AgentDraft {
  name: string;
  description: string;
  scope: SubagentSettingsScope;
  model: string;
  fallbackModels: string;
  thinking: string;
  systemPrompt: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext: string;
  tools: string;
  skills: string;
  maxTurns: string;
  graceTurns: string;
  toolHard: string;
  toolSoft: string;
  toolBlock: string;
  acceptanceRole: string;
  completionGuard: boolean;
  enabled: boolean;
  defaultAsync: boolean;
  timeoutMs: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function SubagentAgentDialog({
  agent,
  builtin = false,
  models,
  skills,
  scope,
  saving,
  onClose,
  onSave,
}: SubagentAgentDialogProps) {
  const draft = useRef<AgentDraft>(createDraft(agent, scope));
  const updateDraft = useCallback((change: Partial<AgentDraft>) => {
    draft.current = { ...draft.current, ...change };
  }, []);
  const title = builtin ? `覆盖 ${agent?.name ?? "智能体"}` : agent ? `编辑 ${agent.name}` : "新建智能体";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const current = draft.current;
    const config: SubagentAgentConfigInput = {
      ...(builtin ? {} : { name: current.name.trim(), description: current.description.trim() }),
      model: current.model || false,
      fallbackModels: csv(current.fallbackModels),
      thinking: current.thinking === "inherit" ? false : (current.thinking as SubagentAgentConfigInput["thinking"]),
      systemPrompt: current.systemPrompt,
      systemPromptMode: current.systemPromptMode,
      inheritProjectContext: current.inheritProjectContext,
      inheritSkills: current.inheritSkills,
      defaultContext: current.defaultContext === "inherit" ? false : (current.defaultContext as "fresh" | "fork"),
      tools: csv(current.tools),
      skills: csv(current.skills),
      acceptanceRole: current.acceptanceRole === "none" ? false : (current.acceptanceRole as "read-only" | "writer"),
      completionGuard: current.completionGuard,
      disabled: !current.enabled,
      ...(builtin
        ? {}
        : {
            async: current.defaultAsync,
            timeoutMs: positiveInteger(current.timeoutMs) ?? false,
            turnBudget: positiveInteger(current.maxTurns)
              ? {
                  maxTurns: positiveInteger(current.maxTurns)!,
                  ...(nonNegativeInteger(current.graceTurns) !== undefined
                    ? { graceTurns: nonNegativeInteger(current.graceTurns) }
                    : {}),
                }
              : false,
          }),
      toolBudget: positiveInteger(current.toolHard)
        ? {
            hard: positiveInteger(current.toolHard)!,
            ...(positiveInteger(current.toolSoft) ? { soft: positiveInteger(current.toolSoft) } : {}),
            ...(current.toolBlock.trim()
              ? { block: current.toolBlock.trim() === "*" ? "*" : csv(current.toolBlock) || [] }
              : {}),
          }
        : false,
    };
    if (await onSave(current.scope, config)) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="subagent-editor-dialog w-[min(65rem,calc(100vw-32px))] max-w-none gap-0 p-0">
        <div className="subagent-editor-header">
          <div className="subagent-editor-header-text">
            <h2>{title}</h2>
            <p>智能体配置</p>
          </div>
        </div>
        <form id="subagent-agent-form" className="subagent-editor-form" onSubmit={(event) => void submit(event)}>
          <div className="subagent-form-grid">
            <SubagentFormField label="名称">
              <Input
                required
                disabled={builtin || Boolean(agent)}
                defaultValue={draft.current.name}
                placeholder="例如：code-reviewer，可用字母、数字和连字符"
                onChange={(event) => updateDraft({ name: event.target.value })}
              />
            </SubagentFormField>
            <SubagentFormField label="作用域">
              <Input disabled value={scope === "user" ? "个人" : "项目"} />
            </SubagentFormField>
          </div>

          <SubagentFormField label="描述">
            <Textarea
              required={!builtin}
              disabled={builtin}
              defaultValue={draft.current.description}
              className="min-h-[4.5rem]"
              placeholder="说明该智能体擅长什么、何时应被调用"
              onChange={(event) => updateDraft({ description: event.target.value })}
            />
          </SubagentFormField>

          <SubagentModelField
            initialModel={draft.current.model}
            models={models}
            onValueChange={(model) => updateDraft({ model })}
          />

          <div className="subagent-form-grid">
            <SubagentFormField label="备用模型">
              <Input
                defaultValue={draft.current.fallbackModels}
                placeholder="多个模型用英文逗号分隔，如 openai/gpt-4.1"
                onChange={(event) => updateDraft({ fallbackModels: event.target.value })}
              />
            </SubagentFormField>
            <SubagentFormField label="思考级别">
              <SelectRoot
                defaultValue={draft.current.thinking}
                onValueChange={(value) => updateDraft({ thinking: value })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承</SelectItem>
                  {THINKING_LEVELS.map((level) => {
                    const label: Record<string, string> = {
                      off: "关闭",
                      minimal: "最少",
                      low: "低",
                      medium: "中",
                      high: "高",
                      xhigh: "很高",
                      max: "最高",
                    };
                    return (
                      <SelectItem key={level} value={level}>
                        {label[level] ?? level}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </SelectRoot>
            </SubagentFormField>
          </div>

          <SubagentFormField label="系统提示词">
            <Textarea
              defaultValue={draft.current.systemPrompt}
              className="min-h-[13rem] font-mono text-xs"
              placeholder="自定义系统提示词；留空使用默认提示词"
              onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
            />
          </SubagentFormField>

          <div className="subagent-form-grid">
            <SubagentFormField label="系统提示模式">
              <SelectRoot
                defaultValue={draft.current.systemPromptMode}
                onValueChange={(value) => updateDraft({ systemPromptMode: value as "append" | "replace" })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="replace">替换</SelectItem>
                  <SelectItem value="append">追加</SelectItem>
                </SelectContent>
              </SelectRoot>
            </SubagentFormField>
            <SubagentFormField label="默认上下文">
              <SelectRoot
                defaultValue={draft.current.defaultContext}
                onValueChange={(value) => updateDraft({ defaultContext: value })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">未设置</SelectItem>
                  <SelectItem value="fresh">全新</SelectItem>
                  <SelectItem value="fork">分支</SelectItem>
                </SelectContent>
              </SelectRoot>
            </SubagentFormField>
          </div>

          <div className="subagent-toggle-grid">
            <SubagentToggleField
              label="继承项目上下文"
              defaultChecked={draft.current.inheritProjectContext}
              onCheckedChange={(inheritProjectContext) => updateDraft({ inheritProjectContext })}
            />
            <SubagentToggleField
              label="继承技能"
              defaultChecked={draft.current.inheritSkills}
              onCheckedChange={(inheritSkills) => updateDraft({ inheritSkills })}
            />
            <SubagentToggleField
              label="完成保护"
              defaultChecked={draft.current.completionGuard}
              onCheckedChange={(completionGuard) => updateDraft({ completionGuard })}
            />
            <SubagentToggleField
              label="启用"
              defaultChecked={draft.current.enabled}
              onCheckedChange={(enabled) => updateDraft({ enabled })}
            />
            {!builtin ? (
              <SubagentToggleField
                label="默认异步"
                defaultChecked={draft.current.defaultAsync}
                onCheckedChange={(defaultAsync) => updateDraft({ defaultAsync })}
              />
            ) : null}
          </div>

          <SubagentFormField label="工具">
            <Input
              defaultValue={draft.current.tools}
              placeholder="多个工具用英文逗号分隔，如 read, bash"
              onChange={(event) => updateDraft({ tools: event.target.value })}
            />
          </SubagentFormField>
          <SubagentSkillsField
            initialValue={draft.current.skills}
            skills={skills}
            onValueChange={(value) => updateDraft({ skills: value })}
          />

          {!builtin ? (
            <div className="subagent-form-grid subagent-budget-grid">
              <SubagentFormField label="最大轮次">
                <SelectRoot
                  defaultValue={draft.current.maxTurns}
                  onValueChange={(value) => updateDraft({ maxTurns: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="无限制" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">无限制</SelectItem>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </SubagentFormField>
              <SubagentFormField label="额外轮次">
                <SelectRoot
                  defaultValue={draft.current.graceTurns}
                  onValueChange={(value) => updateDraft({ graceTurns: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="无限制" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">无限制</SelectItem>
                    <SelectItem value="0">0</SelectItem>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                    <SelectItem value="10">10</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </SubagentFormField>
              <SubagentFormField label="超时时间">
                <SelectRoot
                  defaultValue={draft.current.timeoutMs}
                  onValueChange={(value) => updateDraft({ timeoutMs: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="继承" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">继承（无限）</SelectItem>
                    <SelectItem value="5000">5 秒</SelectItem>
                    <SelectItem value="10000">10 秒</SelectItem>
                    <SelectItem value="30000">30 秒</SelectItem>
                    <SelectItem value="60000">1 分钟</SelectItem>
                    <SelectItem value="120000">2 分钟</SelectItem>
                    <SelectItem value="300000">5 分钟</SelectItem>
                    <SelectItem value="600000">10 分钟</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </SubagentFormField>
            </div>
          ) : null}

          <div className="subagent-form-grid subagent-budget-grid">
            <SubagentFormField label="工具预算上限">
              <SelectRoot
                defaultValue={draft.current.toolHard}
                onValueChange={(value) => updateDraft({ toolHard: value })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="无限制" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">无限制</SelectItem>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </SelectRoot>
            </SubagentFormField>
            <SubagentFormField label="工具预算下限">
              <SelectRoot
                defaultValue={draft.current.toolSoft}
                onValueChange={(value) => updateDraft({ toolSoft: value })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="无限制" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">无限制</SelectItem>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </SelectRoot>
            </SubagentFormField>
            <SubagentFormField label="阻断工具">
              <Input
                defaultValue={draft.current.toolBlock}
                placeholder="输入 * 阻断全部，或用英文逗号分隔工具名"
                onChange={(event) => updateDraft({ toolBlock: event.target.value })}
              />
            </SubagentFormField>
          </div>

          <SubagentFormField label="审批角色">
            <SelectRoot
              defaultValue={draft.current.acceptanceRole}
              onValueChange={(value) => updateDraft({ acceptanceRole: value })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无</SelectItem>
                <SelectItem value="read-only">只读</SelectItem>
                <SelectItem value="writer">写入</SelectItem>
              </SelectContent>
            </SelectRoot>
          </SubagentFormField>
        </form>
        <DialogFooter className="subagent-editor-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="subagent-agent-form" disabled={saving}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createDraft(agent: AgentSummary | undefined, scope: SubagentSettingsScope): AgentDraft {
  return {
    name: agent?.localName ?? agent?.name ?? "",
    description: agent?.description ?? "",
    scope,
    model: agent?.model ?? "",
    fallbackModels: agent?.fallbackModels?.join(", ") ?? "",
    thinking: agent?.thinking === false ? "off" : (agent?.thinking ?? "inherit"),
    systemPrompt: agent?.systemPrompt ?? "",
    systemPromptMode: agent?.systemPromptMode ?? "replace",
    inheritProjectContext: agent?.inheritProjectContext ?? false,
    inheritSkills: agent?.inheritSkills ?? false,
    defaultContext: agent?.defaultContext ?? "inherit",
    tools: [...(agent?.tools ?? []), ...(agent?.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)].join(", "),
    skills: agent?.skills?.join(", ") ?? "",
    maxTurns: agent?.turnBudget?.maxTurns?.toString() ?? "",
    graceTurns: agent?.turnBudget?.graceTurns?.toString() ?? "",
    toolHard: agent?.toolBudget?.hard?.toString() ?? "",
    toolSoft: agent?.toolBudget?.soft?.toString() ?? "",
    toolBlock:
      agent?.toolBudget?.block === "*"
        ? "*"
        : Array.isArray(agent?.toolBudget?.block)
          ? agent.toolBudget.block.join(", ")
          : "",
    acceptanceRole: agent?.acceptanceRole ?? "none",
    completionGuard: agent?.completionGuard !== false,
    enabled: agent?.disabled !== true,
    defaultAsync: agent?.defaultAsync ?? false,
    timeoutMs: agent?.defaultTimeoutMs?.toString() ?? "",
  };
}

function csv(value: string): string[] | false {
  const entries = [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  return entries.length ? entries : false;
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
