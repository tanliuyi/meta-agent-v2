import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import { useToast } from "@renderer/shared/ui/use-toast";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { type FormEvent, type ReactNode, type SyntheticEvent, useState } from "react";
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

// 上游对 0 非法（会拒绝或回退默认值）的字段：UI 下限为 1。
// 与 pi-subagents 消费点校验一致：
// turn-budget.ts maxTurns>=1 / tool-budget.ts hard>=1,soft>=1 /
// usage-budget.ts hard>0,soft>0 / parallel normalize>=1 /
// subagent-control.ts parsePositiveInt / completion-batcher.ts parsePositiveInt /
// scheduled-runs.ts maxPending>=1 / checkSubagentDepth 0 会禁止全部子代理。
const POSITIVE_INTEGER_FIELDS = [
  "maxSubagentDepth",
  "globalConcurrencyLimit",
  "scheduledRunsMaxPending",
  "parallelMaxTasks",
  "parallelConcurrency",
  "turnBudgetMaxTurns",
  "toolBudgetHard",
  "toolBudgetSoft",
  "usageBudgetTokensHard",
  "usageBudgetTokensSoft",
  "usageBudgetCostUsdHard",
  "usageBudgetCostUsdSoft",
  "controlNeedsAttentionAfterMs",
  "controlActiveNoticeAfterMs",
  "completionBatchDebounceMs",
  "completionBatchMaxWaitMs",
  "worktreeSetupHookTimeoutMs",
] as const;

const FIELD_LABELS: Record<(typeof POSITIVE_INTEGER_FIELDS)[number], string> = {
  maxSubagentDepth: "最大嵌套深度",
  globalConcurrencyLimit: "全局并行上限",
  scheduledRunsMaxPending: "定时运行最大积压",
  parallelMaxTasks: "并行最大任务数",
  parallelConcurrency: "并行并发数",
  turnBudgetMaxTurns: "回合预算上限",
  toolBudgetHard: "工具预算硬上限",
  toolBudgetSoft: "工具预算软上限",
  usageBudgetTokensHard: "Token 预算硬上限",
  usageBudgetTokensSoft: "Token 预算软上限",
  usageBudgetCostUsdHard: "费用预算硬上限",
  usageBudgetCostUsdSoft: "费用预算软上限",
  controlNeedsAttentionAfterMs: "需关注阈值",
  controlActiveNoticeAfterMs: "活跃提醒阈值",
  completionBatchDebounceMs: "批量防抖时长",
  completionBatchMaxWaitMs: "批量最长等待",
  worktreeSetupHookTimeoutMs: "工作树设置钩子超时",
};

function emptyToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

function optionalNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : undefined;
}

export function SubagentExtensionConfigPanel({ config, saving, onSave }: SubagentExtensionConfigPanelProps) {
  const toast = useToast();
  const [configPanelOpen, setConfigPanelOpen] = useState(true);
  const [baseGroupOpen, setBaseGroupOpen] = useState(false);
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
    scheduledRunsMaxPending: config.scheduledRuns?.maxPending ?? ("" as const),
    scheduledRunsStoreRoot: config.scheduledRuns?.storeRoot ?? "",
    legacyChainControls: config.legacyChainControls ?? false,
    inlineToolDisplay: config.inlineToolDisplay ?? "rich",
    forceTopLevelAsync: config.forceTopLevelAsync ?? false,
    waitToolEnabled: config.waitTool?.enabled ?? true,
    defaultSessionDir: config.defaultSessionDir ?? "",
    singleRunOutputBaseDir: config.singleRunOutputBaseDir ?? "",
    worktreeSetupHook: config.worktreeSetupHook ?? "",
    worktreeSetupHookTimeoutMs: config.worktreeSetupHookTimeoutMs ?? ("" as const),
    worktreeBaseDir: config.worktreeBaseDir ?? "",
    intercomBridgeMode: config.intercomBridge?.mode ?? "off",
    intercomBridgeInstructionFile: config.intercomBridge?.instructionFile ?? "",
    intercomBridgeResultDelivery: config.intercomBridge?.resultDelivery ?? false,
    proactiveSkillSubagentsEnabled:
      config.proactiveSkillSubagents === false ? false : (config.proactiveSkillSubagents?.enabled ?? false),
    proactiveSkillSubagentsPreferredAgent:
      config.proactiveSkillSubagents === false ? "" : (config.proactiveSkillSubagents?.preferredAgent ?? ""),
    missionsEnabled: config.missions?.enabled ?? true,
    authorityPolicy: {
      discardWorktree: config.authorityPolicy?.discardWorktree ?? "confirm",
      destructiveCleanup: config.authorityPolicy?.destructiveCleanup ?? "confirm",
      spawnBudgetGrant: config.authorityPolicy?.spawnBudgetGrant ?? "confirm",
      scheduleCreate: config.authorityPolicy?.scheduleCreate ?? "auto",
      stopRun: config.authorityPolicy?.stopRun ?? "auto",
      steerRun: config.authorityPolicy?.steerRun ?? "auto",
    } as Record<(typeof AUTHORITY_ACTIONS)[number], AuthorityDecision>,
    parallelMaxTasks: config.parallel?.maxTasks ?? ("" as const),
    parallelConcurrency: config.parallel?.concurrency ?? ("" as const),
    chainDynamicFanoutMaxItems: config.chain?.dynamicFanout?.maxItems ?? 0,
    turnBudgetMaxTurns: config.turnBudget?.maxTurns ?? ("" as const),
    turnBudgetGraceTurns: config.turnBudget?.graceTurns ?? 1,
    toolBudgetSoft: config.toolBudget?.soft ?? ("" as const),
    toolBudgetHard: config.toolBudget?.hard ?? ("" as const),
    controlEnabled: config.control?.enabled ?? false,
    controlNeedsAttentionAfterMs: config.control?.needsAttentionAfterMs ?? ("" as const),
    controlActiveNoticeAfterMs: config.control?.activeNoticeAfterMs ?? ("" as const),
    completionBatchEnabled: config.completionBatch?.enabled ?? false,
    completionBatchDebounceMs: config.completionBatch?.debounceMs ?? ("" as const),
    completionBatchMaxWaitMs: config.completionBatch?.maxWaitMs ?? ("" as const),
    usageBudgetTokensSoft: config.usageBudget?.tokens?.soft ?? ("" as const),
    usageBudgetTokensHard: config.usageBudget?.tokens?.hard ?? ("" as const),
    usageBudgetCostUsdSoft: config.usageBudget?.costUsd?.soft ?? ("" as const),
    usageBudgetCostUsdHard: config.usageBudget?.costUsd?.hard ?? ("" as const),
    permissionsRules: config.permissions?.rules
      ? Object.entries(config.permissions.rules)
          .map(([tool, decision]) => `${tool}: ${decision}`)
          .join("\n")
      : "",
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // 空串 = 未设置（沿用上游默认），0 为非法值（上游会拒绝或回退）。
    const num = (value: number | ""): number => (value === "" ? Number.NaN : value);
    for (const key of POSITIVE_INTEGER_FIELDS) {
      if (draft[key] !== "" && draft[key] <= 0) {
        toast.notify({
          title: "配置无效",
          message: `「${FIELD_LABELS[key]}」不能为 0，请填写 ≥ 1 的值，或留空使用上游默认`,
          tone: "error",
        });
        return;
      }
    }
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
        ...(num(draft.scheduledRunsMaxPending) > 0 ? { maxPending: num(draft.scheduledRunsMaxPending) } : {}),
        ...(draft.scheduledRunsStoreRoot ? { storeRoot: draft.scheduledRunsStoreRoot } : {}),
      },
      legacyChainControls: draft.legacyChainControls,
      inlineToolDisplay: draft.inlineToolDisplay as SubagentExtensionConfig["inlineToolDisplay"],
      forceTopLevelAsync: draft.forceTopLevelAsync,
      waitTool: { enabled: draft.waitToolEnabled },
      ...(draft.defaultSessionDir ? { defaultSessionDir: emptyToUndefined(draft.defaultSessionDir) } : {}),
      ...(draft.singleRunOutputBaseDir
        ? {
            singleRunOutputBaseDir: emptyToUndefined(draft.singleRunOutputBaseDir),
          }
        : {}),
      ...(draft.worktreeSetupHook ? { worktreeSetupHook: emptyToUndefined(draft.worktreeSetupHook) } : {}),
      ...(num(draft.worktreeSetupHookTimeoutMs) > 0
        ? { worktreeSetupHookTimeoutMs: num(draft.worktreeSetupHookTimeoutMs) }
        : {}),
      ...(draft.worktreeBaseDir ? { worktreeBaseDir: emptyToUndefined(draft.worktreeBaseDir) } : {}),
      intercomBridge: {
        mode: draft.intercomBridgeMode as IntercomBridgeMode,
        ...(draft.intercomBridgeInstructionFile
          ? {
              instructionFile: emptyToUndefined(draft.intercomBridgeInstructionFile),
            }
          : {}),
        resultDelivery: draft.intercomBridgeResultDelivery,
      },
      proactiveSkillSubagents: draft.proactiveSkillSubagentsEnabled
        ? {
            enabled: true,
            ...(draft.proactiveSkillSubagentsPreferredAgent
              ? {
                  preferredAgent: emptyToUndefined(draft.proactiveSkillSubagentsPreferredAgent),
                }
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
      ...(num(draft.parallelMaxTasks) > 0 || num(draft.parallelConcurrency) > 0
        ? {
            parallel: {
              ...(num(draft.parallelMaxTasks) > 0 ? { maxTasks: num(draft.parallelMaxTasks) } : {}),
              ...(num(draft.parallelConcurrency) > 0 ? { concurrency: num(draft.parallelConcurrency) } : {}),
            },
          }
        : {}),
      ...(num(draft.chainDynamicFanoutMaxItems) > 0
        ? {
            chain: {
              dynamicFanout: {
                maxItems: num(draft.chainDynamicFanoutMaxItems),
              },
            },
          }
        : {}),
      ...(num(draft.turnBudgetMaxTurns) > 0
        ? {
            turnBudget: {
              maxTurns: num(draft.turnBudgetMaxTurns),
              ...(num(draft.turnBudgetGraceTurns) > 0 ? { graceTurns: num(draft.turnBudgetGraceTurns) } : {}),
            },
          }
        : {}),
      ...(num(draft.toolBudgetHard) > 0
        ? {
            toolBudget: {
              hard: num(draft.toolBudgetHard),
              ...(num(draft.toolBudgetSoft) > 0 ? { soft: num(draft.toolBudgetSoft) } : {}),
            },
          }
        : {}),
      ...(draft.controlEnabled ||
      num(draft.controlNeedsAttentionAfterMs) > 0 ||
      num(draft.controlActiveNoticeAfterMs) > 0
        ? {
            control: {
              ...(draft.controlEnabled ? { enabled: true } : {}),
              ...(num(draft.controlNeedsAttentionAfterMs) > 0
                ? {
                    needsAttentionAfterMs: num(draft.controlNeedsAttentionAfterMs),
                  }
                : {}),
              ...(num(draft.controlActiveNoticeAfterMs) > 0
                ? { activeNoticeAfterMs: num(draft.controlActiveNoticeAfterMs) }
                : {}),
            },
          }
        : {}),
      ...(draft.completionBatchEnabled ||
      num(draft.completionBatchDebounceMs) > 0 ||
      num(draft.completionBatchMaxWaitMs) > 0
        ? {
            completionBatch: {
              ...(draft.completionBatchEnabled ? { enabled: true } : {}),
              ...(num(draft.completionBatchDebounceMs) > 0 ? { debounceMs: num(draft.completionBatchDebounceMs) } : {}),
              ...(num(draft.completionBatchMaxWaitMs) > 0 ? { maxWaitMs: num(draft.completionBatchMaxWaitMs) } : {}),
            },
          }
        : {}),
      ...(num(draft.usageBudgetTokensHard) > 0 || num(draft.usageBudgetCostUsdHard) > 0
        ? {
            usageBudget: {
              ...(num(draft.usageBudgetTokensHard) > 0
                ? {
                    tokens: {
                      hard: num(draft.usageBudgetTokensHard),
                      ...(num(draft.usageBudgetTokensSoft) > 0 ? { soft: num(draft.usageBudgetTokensSoft) } : {}),
                    },
                  }
                : {}),
              ...(num(draft.usageBudgetCostUsdHard) > 0
                ? {
                    costUsd: {
                      hard: num(draft.usageBudgetCostUsdHard),
                      ...(num(draft.usageBudgetCostUsdSoft) > 0 ? { soft: num(draft.usageBudgetCostUsdSoft) } : {}),
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

  function numberRow(label: string, key: keyof typeof draft, hint?: string, placeholder?: string): ReactNode {
    return (
      <div className={`settings-row subagent-config-row${hint ? " subagent-config-row-with-hint" : ""}`}>
        <span>{label}</span>
        <Input
          aria-label={label}
          type="number"
          placeholder={placeholder}
          value={draft[key] as number | ""}
          className="subagent-config-input"
          onChange={(event) =>
            setDraft(
              (current) =>
                ({
                  ...current,
                  [key]: event.target.value === "" ? "" : Number(event.target.value),
                }) as typeof current,
            )
          }
        />
        {hint ? <em className="subagent-config-hint">{hint}</em> : null}
      </div>
    );
  }

  function subgroup(title: string, children: ReactNode): ReactNode {
    return (
      <section className="subagent-config-subgroup">
        <h4>{title}</h4>
        {children}
      </section>
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
          className="subagent-config-input"
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

  function handleConfigPanelToggle(event: SyntheticEvent<HTMLDetailsElement>): void {
    setConfigPanelOpen(event.currentTarget.open);
  }

  function handleBaseGroupToggle(event: SyntheticEvent<HTMLDetailsElement>): void {
    setBaseGroupOpen(event.currentTarget.open);
  }

  return (
    <details
      open={configPanelOpen}
      onToggle={handleConfigPanelToggle}
      className="settings-section subagent-section subagent-config-panel"
    >
      <summary className="settings-section-heading subagent-config-summary">
        <h3>全局配置</h3>
        <ChevronDown />
      </summary>
      <form className="subagent-config-form" aria-label="子智能体全局配置" noValidate onSubmit={submit}>
        <details open={baseGroupOpen} onToggle={handleBaseGroupToggle} className="subagent-config-group">
          <summary className="subagent-config-group-heading">
            <span className="subagent-config-group-heading-copy">
              <strong>基础</strong>
              <span>默认运行方式、并发上限与定时任务</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {subgroup(
            "核心",
            <>
              {switchRow("默认异步执行", "asyncByDefault")}
              {switchRow("显示异步运行面板", "asyncWidget")}
              {numberRow("最大嵌套深度", "maxSubagentDepth")}
              {numberRow("每会话最大生成数", "maxSubagentSpawnsPerSession", "0 = 不限制")}
              {numberRow("全局并行上限", "globalConcurrencyLimit")}
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
                  <SelectTrigger aria-label="工具描述模式">
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
                  <SelectTrigger aria-label="产物目录">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">项目目录</SelectItem>
                    <SelectItem value="session">会话目录</SelectItem>
                    <SelectItem value="temp">临时目录</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
            </>,
          )}
          {subgroup(
            "定时运行",
            <>
              {switchRow("启用定时运行", "scheduledRunsEnabled")}
              {numberRow("最大积压", "scheduledRunsMaxPending", undefined, "默认 20")}
              {textRow("存储根目录", "scheduledRunsStoreRoot", "~/… 或绝对路径")}
            </>,
          )}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">
            <span className="subagent-config-group-heading-copy">
              <strong>运行行为</strong>
              <span>并行、链式执行与工具展示方式</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {subgroup(
            "运行模式",
            <>
              {switchRow("旧版链控件", "legacyChainControls")}
              <div className="settings-row subagent-config-row">
                <span>内联工具展示</span>
                <SelectRoot
                  value={draft.inlineToolDisplay}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      inlineToolDisplay: value as NonNullable<SubagentExtensionConfig["inlineToolDisplay"]>,
                    }))
                  }
                >
                  <SelectTrigger aria-label="内联工具展示">
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
            </>,
          )}
          {subgroup(
            "并行执行",
            <>
              {numberRow("最大任务数", "parallelMaxTasks", undefined, "默认 8")}
              {numberRow("并发数", "parallelConcurrency", undefined, "默认 4")}
            </>,
          )}
          {subgroup("链式执行", <>{numberRow("动态扇出最大项数", "chainDynamicFanoutMaxItems", "0 = 不展开")}</>)}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">
            <span className="subagent-config-group-heading-copy">
              <strong>目录与脚本</strong>
              <span>会话、产物与工作树相关路径</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {subgroup(
            "通用目录",
            <>
              {textRow("默认会话目录", "defaultSessionDir")}
              {textRow("单次运行输出目录", "singleRunOutputBaseDir")}
            </>,
          )}
          {subgroup(
            "工作树",
            <>
              {textRow("基目录", "worktreeBaseDir")}
              {textRow("设置钩子脚本", "worktreeSetupHook", "path/to/script.mjs")}
              {numberRow("钩子超时（毫秒）", "worktreeSetupHookTimeoutMs", undefined, "留空 = 未设置")}
            </>,
          )}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">
            <span className="subagent-config-group-heading-copy">
              <strong>预算与节流</strong>
              <span>回合、工具、Token 与费用限制</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {subgroup(
            "回合预算",
            <>
              {numberRow("上限", "turnBudgetMaxTurns", undefined, "留空 = 未设置")}
              {numberRow("宽限", "turnBudgetGraceTurns", "默认 1；0 = 无宽限")}
            </>,
          )}
          {subgroup(
            "工具预算",
            <>
              {numberRow("硬上限", "toolBudgetHard", undefined, "留空 = 未设置")}
              {numberRow("软上限", "toolBudgetSoft", undefined, "留空 = 未设置")}
            </>,
          )}
          {subgroup(
            "运行控制（长时间运行提醒）",
            <>
              {switchRow("启用", "controlEnabled")}
              {numberRow("需关注阈值（毫秒）", "controlNeedsAttentionAfterMs", undefined, "默认 60000（1 分钟）")}
              {numberRow("活跃提醒阈值（毫秒）", "controlActiveNoticeAfterMs", undefined, "默认 240000（4 分钟）")}
            </>,
          )}
          {subgroup(
            "完成批量通知",
            <>
              {switchRow("启用", "completionBatchEnabled")}
              {numberRow("防抖时长（毫秒）", "completionBatchDebounceMs", undefined, "默认 150")}
              {numberRow("最长等待（毫秒）", "completionBatchMaxWaitMs", undefined, "默认 1000")}
            </>,
          )}
          {subgroup(
            "Token 预算",
            <>
              {numberRow("硬上限", "usageBudgetTokensHard", undefined, "留空 = 未设置")}
              {numberRow("软上限", "usageBudgetTokensSoft", undefined, "留空 = 未设置")}
            </>,
          )}
          {subgroup(
            "费用预算（美元）",
            <>
              {numberRow("硬上限", "usageBudgetCostUsdHard", undefined, "留空 = 未设置")}
              {numberRow("软上限", "usageBudgetCostUsdSoft", undefined, "留空 = 未设置")}
            </>,
          )}
        </details>

        <details className="subagent-config-group">
          <summary className="subagent-config-group-heading">
            <span className="subagent-config-group-heading-copy">
              <strong>策略与集成</strong>
              <span>任务记录、协作桥接与权限决策</span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {subgroup("任务记录", <>{switchRow("自动记录（missions）", "missionsEnabled")}</>)}
          {subgroup(
            "技能子代理",
            <>
              {switchRow("主动推荐技能子代理", "proactiveSkillSubagentsEnabled")}
              {textRow("推荐偏好代理", "proactiveSkillSubagentsPreferredAgent")}
            </>,
          )}
          {subgroup(
            "协调桥接（intercom）",
            <>
              <div className="settings-row subagent-config-row">
                <span>桥接模式</span>
                <SelectRoot
                  value={draft.intercomBridgeMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      intercomBridgeMode: value as IntercomBridgeMode,
                    }))
                  }
                >
                  <SelectTrigger aria-label="协调桥接模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">关闭</SelectItem>
                    <SelectItem value="fork-only">仅分支</SelectItem>
                    <SelectItem value="always">始终</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </div>
              {textRow("指令文件", "intercomBridgeInstructionFile")}
              {switchRow("外部确认的结果投递", "intercomBridgeResultDelivery")}
            </>,
          )}
          {subgroup(
            "权限策略",
            <>
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
                    <SelectTrigger aria-label={`权限策略 ${action}`}>
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
                  className="subagent-config-permissions-input"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      permissionsRules: event.target.value,
                    }))
                  }
                />
              </div>
            </>,
          )}
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
