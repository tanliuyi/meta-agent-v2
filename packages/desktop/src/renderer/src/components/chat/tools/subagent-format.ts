/** subagent 工具参数与 details 的结构化解析，供标题与详情 UI 复用。 */

export type SubagentCallMode = "single" | "parallel" | "chain" | "management" | "wait";

export interface SubagentTaskSpec {
  /** chain 步骤序号（从 1 开始），并行任务无序号。 */
  step?: number;
  agent: string;
  task: string;
  /** parallel 任务的重复份数（count > 1 时展示）。 */
  count?: number;
}

export interface SubagentCallSummary {
  mode: SubagentCallMode;
  /** management 模式的动作名，如 status/stop/steer。 */
  action?: string;
  /** management/wait 模式操作对象（agent、chainName 或运行 id）。 */
  actionTarget?: string;
  async: boolean;
  waitAll?: boolean;
  waitId?: string;
  /** parallel 任务总数（含 count 展开）、chain 步骤数或 single 的 1。 */
  taskCount: number;
  specs: SubagentTaskSpec[];
}

export type SubagentRowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timed-out"
  | "interrupted"
  | "stopped"
  | "detached";

export interface SubagentAgentRow {
  key: string;
  agent: string;
  status: SubagentRowStatus;
  statusLabel: string;
  /** 运行中显示当前工具，完成后显示模型名。 */
  detail?: string;
  /** 工具次数 / tokens / 耗时 / 费用 等紧凑指标。 */
  meta: string[];
  output?: string;
  error?: string;
}

export interface SubagentDetailsSummary {
  mode?: string;
  runId?: string;
  asyncId?: string;
  timedOut: boolean;
  stopped: boolean;
  chainAgents?: string[];
  totalSteps?: number;
  currentStepIndex?: number;
  rows: SubagentAgentRow[];
  /** 汇总行，如「共 3 个子任务 · 45.2k tokens · $0.12」。 */
  summary?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "undefined" || normalized === "null" ? undefined : value;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modelDetail(record: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!record) return undefined;
  const provider = readString(record, "provider");
  const model = readString(record, "model");
  if (provider && model) return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  return model ?? provider;
}

/** 取首行并压缩空白，用于折叠标题里的任务摘要。 */
export function firstLineSummary(value: string): string {
  return value.split("\n", 1)[0]?.trim().replace(/\s+/g, " ") ?? "";
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

function taskSpec(record: Readonly<Record<string, unknown>>, step?: number): SubagentTaskSpec {
  const count = readNumber(record, "count");
  return {
    ...(step === undefined ? {} : { step }),
    agent: readString(record, "agent") ?? "?",
    task: readString(record, "task") ?? readString(record, "label") ?? "",
    ...(count !== undefined && count > 1 ? { count } : {}),
  };
}

/** 从 subagent / subagent_wait 参数还原调用形态。 */
export function parseSubagentCall(name: string, args: Readonly<Record<string, unknown>>): SubagentCallSummary {
  if (name === "subagent_wait") {
    const waitId = typeof args.id === "string" ? args.id : undefined;
    return {
      mode: "wait",
      async: false,
      waitAll: args.all === true,
      ...(waitId ? { waitId } : {}),
      taskCount: 0,
      specs: [],
    };
  }

  const async = args.async === true && args.clarify !== true;
  if (typeof args.action === "string" && args.action.length > 0) {
    const actionTarget =
      readString(args, "agent") ?? readString(args, "chainName") ?? readString(args, "id") ?? readString(args, "runId");
    return {
      mode: "management",
      action: args.action,
      ...(actionTarget ? { actionTarget } : {}),
      async,
      taskCount: 0,
      specs: [],
    };
  }

  if (Array.isArray(args.chain) && args.chain.length > 0) {
    const specs: SubagentTaskSpec[] = [];
    args.chain.forEach((item, index) => {
      if (!isRecord(item)) return;
      const step = index + 1;
      if (Array.isArray(item.parallel)) {
        for (const sub of item.parallel) if (isRecord(sub)) specs.push(taskSpec(sub, step));
        return;
      }
      if (isRecord(item.parallel)) {
        specs.push(taskSpec(item.parallel, step));
        return;
      }
      specs.push(taskSpec(item, step));
    });
    return { mode: "chain", async, taskCount: args.chain.length, specs };
  }

  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const specs = args.tasks.filter(isRecord).map((item) => taskSpec(item));
    const taskCount = specs.reduce((total, spec) => total + (spec.count ?? 1), 0);
    return { mode: "parallel", async, taskCount, specs };
  }

  const agent = readString(args, "agent");
  const task = readString(args, "task");
  return {
    mode: "single",
    async,
    taskCount: 1,
    specs: [{ agent: agent ?? "?", task: task ?? "" }],
  };
}

/** 折叠标题里的 agent 概览：去重并最多展示 3 个。 */
export function summarizeAgents(specs: readonly SubagentTaskSpec[], separator: string): string {
  const agents = [...new Set(specs.map((spec) => spec.agent))];
  const visible = agents.slice(0, 3).join(separator);
  return agents.length > 3 ? `${visible}${separator}…` : visible;
}

const PROGRESS_STATUS_LABELS: Readonly<Record<string, { status: SubagentRowStatus; label: string }>> = {
  pending: { status: "pending", label: "等待中" },
  running: { status: "running", label: "运行中" },
  completed: { status: "completed", label: "完成" },
  failed: { status: "failed", label: "失败" },
  detached: { status: "detached", label: "后台运行" },
};

function progressRow(
  record: Readonly<Record<string, unknown>>,
  index: number,
  resultRecord?: Readonly<Record<string, unknown>>,
): SubagentAgentRow {
  const mapped = PROGRESS_STATUS_LABELS[readString(record, "status") ?? ""] ?? PROGRESS_STATUS_LABELS.running;
  const meta: string[] = [];
  const toolCount = readNumber(record, "toolCount");
  if (toolCount !== undefined && toolCount > 0) meta.push(`${toolCount} 次工具`);
  const tokens = readNumber(record, "tokens");
  if (tokens !== undefined && tokens > 0) meta.push(`${formatTokenCount(tokens)} tok`);
  const durationMs = readNumber(record, "durationMs");
  if (durationMs !== undefined && durationMs > 0) meta.push(formatDurationMs(durationMs));

  const currentTool = readString(record, "currentTool");
  const currentToolArgs = readString(record, "currentToolArgs");
  const detail =
    mapped.status === "running" && currentTool
      ? `${currentTool}${currentToolArgs ? ` ${firstLineSummary(currentToolArgs)}` : ""}`
      : modelDetail(resultRecord);
  const errorText = readString(record, "error");

  return {
    key: `progress:${readNumber(record, "index") ?? index}`,
    agent: readString(record, "agent") ?? "?",
    status: mapped.status,
    statusLabel: mapped.label,
    ...(detail ? { detail } : {}),
    meta,
    ...(errorText ? { error: errorText } : {}),
  };
}

function resultStatus(record: Readonly<Record<string, unknown>>): { status: SubagentRowStatus; label: string } {
  if (record.detached === true) return { status: "detached", label: "后台运行" };
  if (record.timedOut === true) return { status: "timed-out", label: "超时" };
  if (record.interrupted === true) return { status: "interrupted", label: "已中断" };
  if (record.stopped === true) return { status: "stopped", label: "已停止" };
  const exitCode = readNumber(record, "exitCode");
  if (readString(record, "error") || (exitCode !== undefined && exitCode !== 0)) {
    return { status: "failed", label: "失败" };
  }
  return { status: "completed", label: "完成" };
}

function resultRow(record: Readonly<Record<string, unknown>>, index: number): SubagentAgentRow {
  const { status, label } = resultStatus(record);
  const meta: string[] = [];
  const usage = isRecord(record.usage) ? record.usage : undefined;
  if (usage) {
    const turns = readNumber(usage, "turns");
    if (turns !== undefined && turns > 0) meta.push(`${turns} 轮`);
    const input = readNumber(usage, "input") ?? 0;
    const output = readNumber(usage, "output") ?? 0;
    if (input + output > 0) meta.push(`${formatTokenCount(input + output)} tok`);
    const cost = readNumber(usage, "cost");
    if (cost !== undefined && cost > 0) meta.push(formatCost(cost));
  }
  const progressSummary = isRecord(record.progressSummary) ? record.progressSummary : undefined;
  const durationMs = progressSummary ? readNumber(progressSummary, "durationMs") : undefined;
  if (durationMs !== undefined && durationMs > 0) meta.push(formatDurationMs(durationMs));

  const output = readString(record, "finalOutput");
  const errorText = readString(record, "error");
  return {
    key: `result:${index}`,
    agent: readString(record, "agent") ?? "?",
    status,
    statusLabel: label,
    ...(modelDetail(record) ? { detail: modelDetail(record) } : {}),
    meta,
    ...(output ? { output } : {}),
    ...(errorText ? { error: errorText } : {}),
  };
}

function isLiveProgressStatus(record: Readonly<Record<string, unknown>> | undefined): boolean {
  const status = record ? readString(record, "status") : undefined;
  return status === "pending" || status === "running";
}

/** 解析 subagent details（含流式 partial details），合并进度与结果为逐 agent 行。 */
export function parseSubagentDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): SubagentDetailsSummary | undefined {
  if (!details || !("results" in details || "progress" in details || "asyncId" in details || "mode" in details)) {
    return undefined;
  }
  const results = Array.isArray(details.results) ? details.results.filter(isRecord) : [];
  const progress = Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];

  const rows: SubagentAgentRow[] = [];
  const rowCount = Math.max(results.length, progress.length);
  for (let index = 0; index < rowCount; index += 1) {
    const progressRecord = progress[index];
    const resultRecord = results[index];
    if (resultRecord && !isLiveProgressStatus(progressRecord)) {
      rows.push(resultRow(resultRecord, index));
    } else if (progressRecord) {
      rows.push(progressRow(progressRecord, index, resultRecord));
    } else if (resultRecord) {
      rows.push(resultRow(resultRecord, index));
    }
  }

  const summaryParts: string[] = [];
  if (rows.length > 1) summaryParts.push(`共 ${rows.length} 个子任务`);
  const totalUsage = isRecord(details.totalChildUsage) ? details.totalChildUsage : undefined;
  if (totalUsage) {
    const tokens = (readNumber(totalUsage, "input") ?? 0) + (readNumber(totalUsage, "output") ?? 0);
    if (tokens > 0) summaryParts.push(`${formatTokenCount(tokens)} tokens`);
  }
  const totalCost = isRecord(details.totalCost) ? readNumber(details.totalCost, "costUsd") : undefined;
  if (totalCost !== undefined && totalCost > 0) summaryParts.push(formatCost(totalCost));

  const chainAgents = Array.isArray(details.chainAgents)
    ? details.chainAgents.filter((agent): agent is string => typeof agent === "string")
    : undefined;

  return {
    ...(readString(details, "mode") ? { mode: readString(details, "mode") } : {}),
    ...(readString(details, "runId") ? { runId: readString(details, "runId") } : {}),
    ...(readString(details, "asyncId") ? { asyncId: readString(details, "asyncId") } : {}),
    timedOut: details.timedOut === true,
    stopped: details.stopped === true,
    ...(chainAgents && chainAgents.length > 0 ? { chainAgents } : {}),
    ...(readNumber(details, "totalSteps") !== undefined ? { totalSteps: readNumber(details, "totalSteps") } : {}),
    ...(readNumber(details, "currentStepIndex") !== undefined
      ? { currentStepIndex: readNumber(details, "currentStepIndex") }
      : {}),
    rows,
    ...(summaryParts.length > 0 ? { summary: summaryParts.join(" · ") } : {}),
  };
}
