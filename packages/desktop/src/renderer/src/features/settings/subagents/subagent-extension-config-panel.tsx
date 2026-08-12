import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { type FormEvent, type ReactNode, useState } from "react";
import type { SubagentExtensionConfig } from "../../../../../shared/subagent-contracts.ts";

interface SubagentExtensionConfigPanelProps {
  config: SubagentExtensionConfig;
  saving: boolean;
  onSave(config: Partial<SubagentExtensionConfig>): Promise<boolean>;
}

type IntercomBridgeMode = "off" | "fork-only" | "always";
type AuthorityDecision = "auto" | "confirm" | "forbid";

const AUTHORITY_ACTIONS = [
  "discardWorktree",
  "destructiveCleanup",
  "spawnBudgetGrant",
  "scheduleCreate",
  "stopRun",
  "steerRun",
] as const;

function emptyToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

function optionalNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : undefined;
}

export function SubagentExtensionConfigPanel({ config, saving, onSave }: SubagentExtensionConfigPanelProps) {
  // draft 默认值与上游运行时语义保持一致（resolveAsyncByDefault 缺省 true、
  // DEFAULT_SUBAGENT_MAX_DEPTH=2、scheduledRuns.enabled 缺省 true、
  // waitTool 缺省启用、missions 自动创建缺省开启、authorityPolicy 默认决策），
  // 保证 UI 展示与 pi-subagents 实际行为一致。
  const [draft, setDraft] = useState({
    asyncByDefault: config.asyncByDefault ?? true,
    asyncWidget: config.asyncWidget ?? true,
    maxSubagentDepth: config.maxSubagentDepth ?? 2,
    maxSubagentSpawnsPerSession: config.maxSubagentSpawnsPerSession ?? 0,
    globalConcurrencyLimit: config.globalConcurrencyLimit ?? 20,
    toolDescriptionMode: config.toolDescriptionMode ?? "full",
    artifactDir: config.artifactDir ?? "project",
    scheduledRunsEnabled: config.scheduledRuns?.enabled ?? true,
    scheduledRunsMaxPending: config.scheduledRuns?.maxPending ?? 0,
    scheduledRunsStoreRoot: config.scheduledRuns?.storeRoot ?? "",
    legacyChainControls: config.legacyChainControls ?? false,
    inlineToolDisplay: config.inlineToolDisplay ?? "rich",
    forceTopLevelAsync: config.forceTopLevelAsync ?? false,
    waitToolEnabled: config.waitTool?.enabled ?? true,
    defaultSessionDir: config.defaultSessionDir ?? "",
    singleRunOutputBaseDir: config.singleRunOutputBaseDir ?? "",
    worktreeSetupHook: config.worktreeSetupHook ?? "",
    worktreeSetupHookTimeoutMs: config.worktreeSetupHookTimeoutMs ?? 0,
    worktreeBaseDir: config.worktreeBaseDir ?? "",
    intercomBridgeMode: config.intercomBridge?.mode ?? "off",
    intercomBridgeInstructionFile: config.intercomBridge?.instructionFile ?? "",
    intercomBridgeResultDelivery: config.intercomBridge?.resultDelivery ?? false,
    proactiveSkillSubagentsEnabled:
      config.proactiveSkillSubagents === false ? false : (config.proactiveSkillSubagents?.enabled ?? false),
    proactiveSkillSubagentsPreferredAgent: config.proactiveSkillSubagents?.preferredAgent ?? "",
    missionsEnabled: config.missions?.enabled ?? true,
    authorityPolicy: {
      discardWorktree: config.authorityPolicy?.discardWorktree ?? "confirm",
      destructiveCleanup: config.authorityPolicy?.destructiveCleanup ?? "confirm",
      spawnBudgetGrant: config.authorityPolicy?.spawnBudgetGrant ?? "confirm",
      scheduleCreate: config.authorityPolicy?.scheduleCreate ?? "auto",
      stopRun: config.authorityPolicy?.stopRun ?? "auto",
      steerRun: config.authorityPolicy?.steerRun ?? "auto",
    } as Record<(typeof AUTHORITY_ACTIONS)[number], AuthorityDecision>,
    parallelMaxTasks: config.parallel?.maxTasks ?? 0,
    parallelConcurrency: config.parallel?.concurrency ?? 0,
    chainDynamicFanoutMaxItems: config.chain?.dynamicFanout?.maxItems ?? 0,
    turnBudgetMaxTurns: config.turnBudget?.maxTurns ?? 0,
    turnBudgetGraceTurns: config.turnBudget?.graceTurns ?? 0,
    toolBudgetSoft: config.toolBudget?.soft ?? 0,
    toolBudgetHard: config.toolBudget?.hard ?? 0,
    controlEnabled: config.control?.enabled ?? false,
    controlNeedsAttentionAfterMs: config.control?.needsAttentionAfterMs ?? 0,
    controlActiveNoticeAfterMs: config.control?.activeNoticeAfterMs ?? 0,
    completionBatchEnabled: config.completionBatch?.enabled ?? false,
    completionBatchDebounceMs: config.completionBatch?.debounceMs ?? 0,
    completionBatchMaxWaitMs: config.completionBatch?.maxWaitMs ?? 0,
    usageBudgetTokensSoft: config.usageBudget?.tokens?.soft ?? 0,
    usageBudgetTokensHard: config.usageBudget?.tokens?.hard ?? 0,
    usageBudgetCostUsdSoft: config.usageBudget?.costUsd?.soft ?? 0,
    usageBudgetCostUsdHard: config.usageBudget?.costUsd?.hard ?? 0,
    permissionsRules: config.permissions?.rules
      ? Object.entries(config.permissions.rules)
          .map(([tool, decision]) => `${tool}: ${decision}`)
          .join("\n")
      : "",
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onSave({
      asyncByDefault: draft.asyncByDefault,
      asyncWidget: draft.asyncWidget,
      maxSubagentDepth: draft.maxSubagentDepth,
      maxSubagentSpawnsPerSession: draft.maxSubagentSpawnsPerSession,
      globalConcurrencyLimit: draft.globalConcurrencyLimit,
      toolDescriptionMode: draft.toolDescriptionMode as SubagentExtensionConfig["toolDescriptionMode"],
      artifactDir: draft.artifactDir as SubagentExtensionConfig["artifactDir"],
      scheduledRuns: {
        enabled: draft.scheduledRunsEnabled,
        ...(draft.scheduledRunsMaxPending > 0 ? { maxPending: draft.scheduledRunsMaxPending } : {}),
        ...(draft.scheduledRunsStoreRoot ? { storeRoot: draft.scheduledRunsStoreRoot } : {}),
      },
      legacyChainControls: draft.legacyChainControls,
      inlineToolDisplay: draft.inlineToolDisplay as SubagentExtensionConfig["inlineToolDisplay"],
      forceTopLevelAsync: draft.forceTopLevelAsync,
      waitTool: { enabled: draft.waitToolEnabled },
      ...(draft.defaultSessionDir ? { defaultSessionDir: emptyToUndefined(draft.defaultSessionDir) } : {}),
      ...(draft.singleRunOutputBaseDir
        ? { singleRunOutputBaseDir: emptyToUndefined(draft.singleRunOutputBaseDir) }
        : {}),
      ...(draft.worktreeSetupHook ? { worktreeSetupHook: emptyToUndefined(draft.worktreeSetupHook) } : {}),
      ...(draft.worktreeSetupHookTimeoutMs > 0 ? { worktreeSetupHookTimeoutMs: draft.worktreeSetupHookTimeoutMs } : {}),
      ...(draft.worktreeBaseDir ? { worktreeBaseDir: emptyToUndefined(draft.worktreeBaseDir) } : {}),
      intercomBridge: {
        mode: draft.intercomBridgeMode as IntercomBridgeMode,
        ...(draft.intercomBridgeInstructionFile
          ? { instructionFile: emptyToUndefined(draft.intercomBridgeInstructionFile) }
          : {}),
        resultDelivery: draft.intercomBridgeResultDelivery,
      },
      proactiveSkillSubagents: draft.proactiveSkillSubagentsEnabled
        ? {
            enabled: true,
            ...(draft.proactiveSkillSubagentsPreferredAgent
              ? { preferredAgent: emptyToUndefined(draft.proactiveSkillSubagentsPreferredAgent) }
              : {}),
          }
        : false,
      missions: { enabled: draft.missionsEnabled },
      authorityPolicy: {
        discardWorktree: draft.authorityPolicy.discardWorktree,
        destructiveCleanup: draft.authorityPolicy.destructiveCleanup,
        spawnBudgetGrant: draft.authorityPolicy.spawnBudgetGrant,
        scheduleCreate: draft.authorityPolicy.scheduleCreate,
        stopRun: draft.authorityPolicy.stopRun,
        steerRun: draft.authorityPolicy.steerRun,
      },
      ...(draft.parallelMaxTasks > 0 || draft.parallelConcurrency > 0
        ? {
            parallel: {
              ...(draft.parallelMaxTasks > 0 ? { maxTasks: draft.parallelMaxTasks } : {}),
              ...(draft.parallelConcurrency > 0 ? { concurrency: draft.parallelConcurrency } : {}),
            },
          }
        : {}),
      ...(draft.chainDynamicFanoutMaxItems > 0
        ? { chain: { dynamicFanout: { maxItems: draft.chainDynamicFanoutMaxItems } } }
        : {}),
      ...(draft.turnBudgetMaxTurns > 0
        ? {
            turnBudget: {
              maxTurns: draft.turnBudgetMaxTurns,
              ...(draft.turnBudgetGraceTurns > 0 ? { graceTurns: draft.turnBudgetGraceTurns } : {}),
            },
          }
        : {}),
      ...(draft.toolBudgetHard > 0
        ? {
            toolBudget: {
              hard: draft.toolBudgetHard,
              ...(draft.toolBudgetSoft > 0 ? { soft: draft.toolBudgetSoft } : {}),
            },
          }
        : {}),
      ...(draft.controlEnabled || draft.controlNeedsAttentionAfterMs > 0 || draft.controlActiveNoticeAfterMs > 0
        ? {
            control: {
              ...(draft.controlEnabled ? { enabled: true } : {}),
              ...(draft.controlNeedsAttentionAfterMs > 0
                ? { needsAttentionAfterMs: draft.controlNeedsAttentionAfterMs }
                : {}),
              ...(draft.controlActiveNoticeAfterMs > 0
                ? { activeNoticeAfterMs: draft.controlActiveNoticeAfterMs }
                : {}),
            },
          }
        : {}),
      ...(draft.completionBatchEnabled || draft.completionBatchDebounceMs > 0 || draft.completionBatchMaxWaitMs > 0
        ? {
            completionBatch: {
              ...(draft.completionBatchEnabled ? { enabled: true } : {}),
              ...(draft.completionBatchDebounceMs > 0 ? { debounceMs: draft.completionBatchDebounceMs } : {}),
              ...(draft.completionBatchMaxWaitMs > 0 ? { maxWaitMs: draft.completionBatchMaxWaitMs } : {}),
            },
          }
        : {}),
      ...(draft.usageBudgetTokensHard > 0 || draft.usageBudgetCostUsdHard > 0
        ? {
            usageBudget: {
              ...(draft.usageBudgetTokensHard > 0
                ? {
                    tokens: {
                      hard: draft.usageBudgetTokensHard,
                      ...(draft.usageBudgetTokensSoft > 0 ? { soft: draft.usageBudgetTokensSoft } : {}),
                    },
                  }
                : {}),
              ...(draft.usageBudgetCostUsdHard > 0
                ? {
                    costUsd: {
                      hard: draft.usageBudgetCostUsdHard,
                      ...(draft.usageBudgetCostUsdSoft > 0 ? { soft: draft.usageBudgetCostUsdSoft } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(draft.permissionsRules.trim()
        ? {
            permissions: {
              rules: Object.fromEntries(
                draft.permissionsRules
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
                  .map((line) => {
                    const [tool, ...rest] = line.split(":");
                    return [tool.trim(), rest.join(":").trim()];
                  }),
              ) as Record<string, "allow" | "ask" | "deny">,
            },
          }
        : {}),
    });
  }

  function numberRow(label: string, key: keyof typeof draft, min = 0): ReactNode {
    return (
      <div className="settings-row subagent-config-row">
        <span>{label}</span>
        <Input
          aria-label={label}
          type="number"
          min={min}
          value={draft[key] as number}
          className="w-60"
          onChange={(event) =>
            setDraft((current) => ({ ...current, [key]: Number(event.target.value) }) as typeof current)
          }
        />
      </div>
    );
  }

  function textRow(label: string, key: keyof typeof draft, placeholder?: string): ReactNode {
    return (
      <div className="settings-row subagent-config-row">
        <span>{label}</span>
        <Input
          aria-label={label}
          type="text"
          placeholder={placeholder}
          value={draft[key] as string}
          className="w-60"
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }) as typeof current)}
        />
      </div>
    );
  }

  function switchRow(label: string, key: keyof typeof draft): ReactNode {
    return (
      <div className="settings-row subagent-config-row">
        <span>{label}</span>
        <Switch
          aria-label={label}
          checked={draft[key] as boolean}
          onCheckedChange={(checked) => setDraft((current) => ({ ...current, [key]: checked }) as typeof current)}
        />
      </div>
    );
  }

  return (
    <details className="settings-section subagent-section subagent-config-panel">
      <summary className="settings-section-heading subagent-config-summary">
        <h3>全局配置</h3>
        <ChevronDown />
      </summary>
      <form className="subagent-config-form" onSubmit={submit}>
        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">基础</summary>
          {switchRow("默认异步执行", "asyncByDefault")}
          {switchRow("显示异步运行面板", "asyncWidget")}
          {numberRow("最大嵌套深度", "maxSubagentDepth")}
          {numberRow("每会话最大生成数", "maxSubagentSpawnsPerSession")}
          {numberRow("全局并行上限", "globalConcurrencyLimit", 1)}
          <div className="settings-row subagent-config-row">
            <span>工具描述模式</span>
            <SelectRoot
              value={draft.toolDescriptionMode}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  toolDescriptionMode: value as SubagentExtensionConfig["toolDescriptionMode"],
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
                  artifactDir: value as SubagentExtensionConfig["artifactDir"],
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
          {switchRow("定时运行", "scheduledRunsEnabled")}
          {numberRow("定时运行最大积压", "scheduledRunsMaxPending", 1)}
          {textRow("定时运行存储根目录", "scheduledRunsStoreRoot", "~/… 或绝对路径")}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">运行行为</summary>
          {switchRow("旧版链控件", "legacyChainControls")}
          <div className="settings-row subagent-config-row">
            <span>内联工具展示</span>
            <SelectRoot
              value={draft.inlineToolDisplay}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  inlineToolDisplay: value as SubagentExtensionConfig["inlineToolDisplay"],
                }))
              }
            >
              <SelectTrigger className="w-60" aria-label="内联工具展示">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rich">丰富</SelectItem>
                <SelectItem value="summary">摘要</SelectItem>
              </SelectContent>
            </SelectRoot>
          </div>
          {switchRow("顶层强制异步", "forceTopLevelAsync")}
          {switchRow("等待工具（subagent_wait 阻塞）", "waitToolEnabled")}
          {numberRow("并行最大任务数", "parallelMaxTasks", 1)}
          {numberRow("并行并发数", "parallelConcurrency", 1)}
          {numberRow("链动态扇出最大项数", "chainDynamicFanoutMaxItems", 1)}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">目录与脚本</summary>
          {textRow("默认会话目录", "defaultSessionDir")}
          {textRow("单次运行输出目录", "singleRunOutputBaseDir")}
          {textRow("工作树基目录", "worktreeBaseDir")}
          {textRow("工作树设置钩子脚本", "worktreeSetupHook", "path/to/script.mjs")}
          {numberRow("工作树设置钩子超时（毫秒）", "worktreeSetupHookTimeoutMs", 1)}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">预算与节流</summary>
          {numberRow("回合预算上限", "turnBudgetMaxTurns", 1)}
          {numberRow("回合预算宽限", "turnBudgetGraceTurns", 1)}
          {numberRow("工具预算硬上限", "toolBudgetHard", 1)}
          {numberRow("工具预算软上限", "toolBudgetSoft", 1)}
          {switchRow("运行控制（长时间运行提醒）", "controlEnabled")}
          {numberRow("需关注阈值（毫秒）", "controlNeedsAttentionAfterMs", 1)}
          {numberRow("活跃提醒阈值（毫秒）", "controlActiveNoticeAfterMs", 1)}
          {switchRow("完成批量通知", "completionBatchEnabled")}
          {numberRow("批量防抖（毫秒）", "completionBatchDebounceMs", 1)}
          {numberRow("批量最长等待（毫秒）", "completionBatchMaxWaitMs", 1)}
          {numberRow("Token 预算硬上限", "usageBudgetTokensHard", 1)}
          {numberRow("Token 预算软上限", "usageBudgetTokensSoft", 1)}
          {numberRow("费用预算硬上限（美元）", "usageBudgetCostUsdHard", 1)}
          {numberRow("费用预算软上限（美元）", "usageBudgetCostUsdSoft", 1)}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">策略与集成</summary>
          {switchRow("任务自动记录（missions）", "missionsEnabled")}
          {switchRow("技能子代理推荐", "proactiveSkillSubagentsEnabled")}
          {textRow("推荐偏好代理", "proactiveSkillSubagentsPreferredAgent")}
          <div className="settings-row subagent-config-row">
            <span>协调桥接模式</span>
            <SelectRoot
              value={draft.intercomBridgeMode}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  intercomBridgeMode: value as IntercomBridgeMode,
                }))
              }
            >
              <SelectTrigger className="w-60" aria-label="协调桥接模式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">关闭</SelectItem>
                <SelectItem value="fork-only">仅分支</SelectItem>
                <SelectItem value="always">始终</SelectItem>
              </SelectContent>
            </SelectRoot>
          </div>
          {textRow("桥接指令文件", "intercomBridgeInstructionFile")}
          {switchRow("外部确认的结果投递", "intercomBridgeResultDelivery")}
          {AUTHORITY_ACTIONS.map((action) => (
            <div className="settings-row subagent-config-row" key={action}>
              <span>权限策略：{action}</span>
              <SelectRoot
                value={draft.authorityPolicy[action]}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    authorityPolicy: {
                      ...current.authorityPolicy,
                      [action]: value as AuthorityDecision,
                    },
                  }))
                }
              >
                <SelectTrigger className="w-60" aria-label={`权限策略 ${action}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动</SelectItem>
                  <SelectItem value="confirm">询问确认</SelectItem>
                  <SelectItem value="forbid">禁止</SelectItem>
                </SelectContent>
              </SelectRoot>
            </div>
          ))}
          <div className="settings-row subagent-config-row">
            <span>工具权限规则（每行 工具名: allow/ask/deny）</span>
            <Textarea
              aria-label="工具权限规则"
              placeholder={"bash: deny\nweb_search: ask"}
              value={draft.permissionsRules}
              className="w-60 subagent-config-permissions-input"
              onChange={(event) => setDraft((current) => ({ ...current, permissionsRules: event.target.value }))}
            />
          </div>
        </details>

        <div className="subagent-config-actions">
          <Button type="submit" disabled={saving}>
            保存全局配置
          </Button>
        </div>
      </form>
    </details>
  );
}
