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
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { type FormEvent, useRef, useState } from "react";
import type {
  AgentSummary,
  ChainStepConfig,
  ChainSummary,
  SubagentModelOption,
  SubagentSettingsScope,
  SubagentSkillOption,
} from "../../../../shared/subagent-contracts.ts";
import { SubagentSkillsField } from "./subagent-skills-field.tsx";

interface SubagentChainDialogProps {
  chain?: ChainSummary;
  agents: AgentSummary[];
  models: SubagentModelOption[];
  skills: SubagentSkillOption[];
  scope: SubagentSettingsScope;
  saving: boolean;
  onClose(): void;
  onSave(
    scope: SubagentSettingsScope,
    config: { name: string; description: string; steps: ChainStepConfig[] },
  ): Promise<boolean>;
}

interface ChainStepDraft {
  id: string;
  agent: string;
  task: string;
  phase: string;
  label: string;
  output: string;
  reads: string;
  model: string;
  skills: string;
  progress: boolean;
}

export function SubagentChainDialog({
  chain,
  agents,
  models,
  skills = [],
  scope,
  saving,
  onClose,
  onSave,
}: SubagentChainDialogProps) {
  const name = useRef(chain?.localName ?? chain?.name ?? "");
  const description = useRef(chain?.description ?? "");
  const chainScope = useRef<SubagentSettingsScope>(scope);
  const steps = useRef<ChainStepDraft[]>(
    chain?.steps.length ? chain.steps.map(stepDraft) : [emptyStep(agents[0]?.name)],
  );
  const [, rerenderSteps] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.current.trim() || !description.current.trim() || steps.current.some((step) => !step.agent)) return;
    const config = {
      name: name.current.trim(),
      description: description.current.trim(),
      steps: steps.current.map((step) => ({
        agent: step.agent,
        ...(step.task.trim() ? { task: step.task } : {}),
        ...(step.phase.trim() ? { phase: step.phase.trim() } : {}),
        ...(step.label.trim() ? { label: step.label.trim() } : {}),
        ...(step.output.trim()
          ? { output: step.output.trim() === "false" ? (false as const) : step.output.trim() }
          : {}),
        ...(step.reads.trim() ? { reads: csv(step.reads) } : {}),
        ...(step.model ? { model: step.model } : {}),
        ...(step.skills.trim() ? { skills: csv(step.skills) } : {}),
        progress: step.progress,
      })),
    };
    if (await onSave(chainScope.current, config)) onClose();
  }

  function updateStep(index: number, change: Partial<ChainStepDraft>): void {
    const current = steps.current[index];
    if (current) steps.current[index] = { ...current, ...change };
  }

  function moveStep(index: number, offset: -1 | 1): void {
    const target = index + offset;
    if (target < 0 || target >= steps.current.length) return;
    const next = [...steps.current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    steps.current = next;
    rerenderSteps((revision) => revision + 1);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="subagent-editor-dialog subagent-chain-dialog w-[min(65rem,calc(100vw-32px))] max-w-none gap-0 p-0">
        <div className="subagent-editor-header">
          <div className="subagent-editor-header-text">
            <h2>{chain ? `编辑 ${chain.name}` : "新建流程"}</h2>
            <p>流程将按顺序依次执行每个步骤</p>
          </div>
        </div>
        <form id="subagent-chain-form" className="subagent-editor-form" onSubmit={(event) => void submit(event)}>
          <div className="subagent-form-grid">
            <label className="subagent-field">
              <span>名称</span>
              <Input
                required
                defaultValue={name.current}
                placeholder="例如：review-flow，可用字母、数字和连字符"
                onChange={(event) => (name.current = event.target.value)}
              />
            </label>
            <label className="subagent-field">
              <span>作用域</span>
              <Input disabled value={scope === "user" ? "个人" : "项目"} />
            </label>
          </div>
          <label className="subagent-field">
            <span>描述</span>
            <Textarea
              required
              defaultValue={description.current}
              className="min-h-[4.5rem]"
              placeholder="说明这个流程会完成什么任务、适合何时使用"
              onChange={(event) => (description.current = event.target.value)}
            />
          </label>

          <div className="subagent-chain-steps">
            {steps.current.map((step, index) => (
              <section className="subagent-chain-step" key={step.id}>
                <div className="subagent-chain-step-header">
                  <strong>步骤 {index + 1}</strong>
                  <div className="subagent-icon-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="上移"
                      disabled={index === 0}
                      onClick={() => moveStep(index, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="下移"
                      disabled={index === steps.current.length - 1}
                      onClick={() => moveStep(index, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="删除步骤"
                      disabled={steps.current.length === 1}
                      onClick={() => {
                        steps.current = steps.current.filter((_, stepIndex) => stepIndex !== index);
                        rerenderSteps((revision) => revision + 1);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="subagent-form-grid">
                  <label className="subagent-field">
                    <span>智能体</span>
                    <SelectRoot
                      defaultValue={step.agent}
                      onValueChange={(value) => updateStep(index, { agent: value })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择智能体" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">选择智能体</SelectItem>
                        {agents.map((agent) => (
                          <SelectItem key={`${agent.source}:${agent.name}`} value={agent.name}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  </label>
                  <label className="subagent-field">
                    <span>模型</span>
                    <SelectRoot
                      defaultValue={step.model}
                      onValueChange={(value) => updateStep(index, { model: value })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="使用智能体模型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">使用智能体模型</SelectItem>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name} ({model.id})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  </label>
                </div>
                <label className="subagent-field">
                  <span>任务</span>
                  <Textarea
                    className="min-h-[4.5rem]"
                    defaultValue={step.task}
                    placeholder="说明这一步要智能体完成什么"
                    onChange={(event) => updateStep(index, { task: event.target.value })}
                  />
                </label>
                <div className="subagent-form-grid">
                  <label className="subagent-field">
                    <span>阶段</span>
                    <Input
                      defaultValue={step.phase}
                      placeholder="用于归类进度，如：代码检查"
                      onChange={(event) => updateStep(index, { phase: event.target.value })}
                    />
                  </label>
                  <label className="subagent-field">
                    <span>标签</span>
                    <Input
                      defaultValue={step.label}
                      placeholder="运行时显示的名称，如：检查改动"
                      onChange={(event) => updateStep(index, { label: event.target.value })}
                    />
                  </label>
                  <label className="subagent-field">
                    <span>输出路径</span>
                    <SelectRoot
                      defaultValue={step.output}
                      onValueChange={(value) => updateStep(index, { output: value })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="不设置" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">不设置</SelectItem>
                        <SelectItem value="false">禁用输出</SelectItem>
                      </SelectContent>
                    </SelectRoot>
                  </label>
                  <label className="subagent-field">
                    <span>读取路径</span>
                    <Input
                      defaultValue={step.reads}
                      placeholder="多个路径用英文逗号分隔，如 reports/a.md, reports/b.md"
                      onChange={(event) => updateStep(index, { reads: event.target.value })}
                    />
                  </label>
                  <SubagentSkillsField
                    initialValue={step.skills}
                    skills={skills}
                    placeholder="输入或选择技能，多个技能用英文逗号分隔"
                    onValueChange={(value) => updateStep(index, { skills: value })}
                  />
                  <label className="subagent-toggle-field subagent-chain-progress">
                    <span>显示进度</span>
                    <Switch
                      defaultChecked={step.progress}
                      onCheckedChange={(checked) => updateStep(index, { progress: checked })}
                    />
                  </label>
                </div>
              </section>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full border-dashed"
            onClick={() => {
              steps.current = [...steps.current, emptyStep(agents[0]?.name)];
              rerenderSteps((revision) => revision + 1);
            }}
          >
            <Plus />
            添加步骤
          </Button>
        </form>
        <DialogFooter className="subagent-editor-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="subagent-chain-form" disabled={saving}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyStep(agent = ""): ChainStepDraft {
  return {
    id: crypto.randomUUID(),
    agent,
    task: "",
    phase: "",
    label: "",
    output: "",
    reads: "",
    model: "",
    skills: "",
    progress: false,
  };
}

function stepDraft(step: ChainStepConfig): ChainStepDraft {
  return {
    id: crypto.randomUUID(),
    agent: step.agent,
    task: step.task ?? "",
    phase: step.phase ?? "",
    label: step.label ?? "",
    output: step.output === false ? "false" : (step.output ?? ""),
    reads: step.reads === false ? "false" : (step.reads?.join(", ") ?? ""),
    model: step.model ?? "",
    skills: step.skills === false ? "false" : (step.skills?.join(", ") ?? ""),
    progress: step.progress ?? false,
  };
}

function csv(value: string): string[] | false {
  if (value.trim() === "false") return false;
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
