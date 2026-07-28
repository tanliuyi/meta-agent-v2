import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { firstLineSummary, parseSubagentDetails } from "../../tools/subagent-format.ts";
import { notificationDetails, notificationText } from "../notification-data.ts";

export type SubagentNotificationStatus = "completed" | "failed" | "paused" | "running";

export type AcceptanceCriterionStatus = "not-applicable" | "not-satisfied" | "satisfied";

export interface AcceptanceCriterion {
  id?: string;
  status: AcceptanceCriterionStatus;
  evidence: string;
}

export interface AcceptanceCommand {
  command: string;
  result?: string;
  summary?: string;
}

export interface AcceptanceReport {
  satisfied: boolean;
  criteria: AcceptanceCriterion[];
  changedFiles: string[];
  tests: string[];
  commands: AcceptanceCommand[];
  validationOutput: string[];
  residualRisks: string[];
  reviewFindings: string[];
  noStagedFiles?: boolean;
  diffSummary?: string;
  manualNotes?: string;
}

export interface SubagentNotificationItem {
  key: string;
  agent: string;
  status: SubagentNotificationStatus;
  statusLabel: string;
  meta: string[];
  summary: string;
  markdown?: string;
  report?: AcceptanceReport;
  sessionLabel?: string;
  sessionValue?: string;
}

export interface SubagentNotificationSummary {
  items: SubagentNotificationItem[];
  tone: "info" | "warning" | "error";
}

interface SanitizedOutput {
  markdown: string;
  report?: AcceptanceReport;
  suppressedJson: boolean;
}

export function parseSubagentNotification(notice: PiNoticeMessage): SubagentNotificationSummary {
  const details = asRecord(notificationDetails(notice));
  const completionItems = Array.isArray(details?.items)
    ? details.items.filter(isRecord).map((item, index) => completionItem(item, index))
    : details && isCompletionDetails(details)
      ? [completionItem(details, 0)]
      : [];
  const items = completionItems.length > 0 ? completionItems : slashResultItems(details, notificationText(notice));
  const fallbackItems = items.length > 0 ? items : [fallbackItem(notificationText(notice))];
  const tone = fallbackItems.some((item) => item.status === "failed")
    ? "error"
    : fallbackItems.some((item) => item.status === "paused")
      ? "warning"
      : "info";
  return { items: fallbackItems, tone };
}

function completionItem(details: Readonly<Record<string, unknown>>, index: number): SubagentNotificationItem {
  const status = normalizeStatus(readString(details, "status"));
  const output = sanitizeOutput(readString(details, "resultPreview") ?? "");
  const meta: string[] = [];
  const durationMs = readNumber(details, "durationMs");
  if (durationMs !== undefined) meta.push(formatDuration(durationMs));
  const taskInfo = readString(details, "taskInfo");
  if (taskInfo) meta.push(taskInfo.replace(/^\(|\)$/g, ""));
  return createItem({
    key: `completion:${index}`,
    agent: readString(details, "agent") ?? "子代理",
    status,
    meta,
    output,
    sessionLabel: readString(details, "sessionLabel"),
    sessionValue: readString(details, "sessionValue"),
  });
}

function slashResultItems(
  details: Readonly<Record<string, unknown>> | undefined,
  fallbackText: string,
): SubagentNotificationItem[] {
  const result = asRecord(details?.result);
  const parsed = parseSubagentDetails(asRecord(result?.details));
  if (!parsed || parsed.rows.length === 0) {
    return [
      createItem({
        key: "slash:0",
        agent: "子代理",
        status: "completed",
        meta: [],
        output: sanitizeOutput(fallbackText),
      }),
    ];
  }
  return parsed.rows.map((row, index) =>
    createItem({
      key: row.key || `slash:${index}`,
      agent: row.agent,
      status:
        row.status === "failed" || row.status === "timed-out" || row.status === "interrupted"
          ? "failed"
          : row.status === "running" || row.status === "pending" || row.status === "detached"
            ? "running"
            : row.status === "stopped"
              ? "paused"
              : "completed",
      meta: row.meta,
      output: sanitizeOutput(row.output ?? row.error ?? (parsed.rows.length === 1 ? fallbackText : "")),
    }),
  );
}

function fallbackItem(text: string): SubagentNotificationItem {
  return createItem({ key: "fallback", agent: "子代理", status: "completed", meta: [], output: sanitizeOutput(text) });
}

function createItem(input: {
  key: string;
  agent: string;
  status: SubagentNotificationStatus;
  meta: string[];
  output: SanitizedOutput;
  sessionLabel?: string;
  sessionValue?: string;
}): SubagentNotificationItem {
  const reportSummary = input.output.report ? acceptanceSummary(input.output.report) : undefined;
  const summary =
    plainSummary(input.output.markdown) ||
    reportSummary ||
    (input.output.suppressedJson ? "结构化结果已收起" : "无输出");
  return {
    key: input.key,
    agent: input.agent,
    status: input.status,
    statusLabel: statusLabel(input.status),
    meta: input.meta,
    summary,
    ...(input.output.markdown ? { markdown: input.output.markdown } : {}),
    ...(input.output.report ? { report: input.output.report } : {}),
    ...(input.sessionLabel ? { sessionLabel: input.sessionLabel } : {}),
    ...(input.sessionValue ? { sessionValue: input.sessionValue } : {}),
  };
}

function sanitizeOutput(value: string): SanitizedOutput {
  let report: AcceptanceReport | undefined;
  let suppressedJson = false;
  const withoutAcceptanceReports = value.replace(
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (block, rawLanguage: string, rawBody: string) => {
      const language = rawLanguage.trim().toLowerCase();
      const explicitReport = language === "acceptance-report" || language === "acceptance_report";
      const genericJson = language === "json" || language === "jsonc" || language === "json5";
      if (!explicitReport && !genericJson) return block;
      const parsed = parseJsonRecord(rawBody);
      if (!parsed || (genericJson && !hasGenericAcceptanceReportSignal(parsed))) return block;
      const parsedReport = parseAcceptanceReport(parsed);
      if (!parsedReport) return block;
      report ??= parsedReport;
      suppressedJson = true;
      return "";
    },
  );
  const trimmed = withoutAcceptanceReports.trim();
  const wholeJson = parseJsonRecord(trimmed);
  const wholeReport =
    wholeJson && hasGenericAcceptanceReportSignal(wholeJson) ? parseAcceptanceReport(wholeJson) : undefined;
  if (wholeReport) {
    report ??= wholeReport;
    suppressedJson = true;
    return { markdown: "", report, suppressedJson };
  }
  return { markdown: trimmed, ...(report ? { report } : {}), suppressedJson };
}

function parseAcceptanceReport(value: Readonly<Record<string, unknown>>): AcceptanceReport | undefined {
  const wrapperKeys = ["acceptance", "acceptance-report", "acceptance_report", "acceptanceReport"].filter((key) =>
    asRecord(value[key]),
  );
  if (wrapperKeys.length > 1 || (wrapperKeys.length === 1 && Object.keys(value).length !== 1)) return undefined;
  const wrapped = wrapperKeys.length === 1 ? asRecord(value[wrapperKeys[0]!]) : undefined;
  const report = wrapped ?? value;
  if (!isValidAcceptanceShape(report)) return undefined;
  const criteria = recordArray(readAlias(report, "criteriaSatisfied", "criteria_satisfied")).map((criterion) => ({
    ...(readString(criterion, "id") ? { id: normalizedToken(readString(criterion, "id")) } : {}),
    status: criterionStatus(criterion)!,
    evidence: readString(criterion, "evidence")!,
  }));
  const changedFiles = stringArray(readAlias(report, "changedFiles", "changed_files"));
  const tests = stringArray(readAlias(report, "testsAddedOrUpdated", "tests_added_or_updated"));
  const commands = recordArray(readAlias(report, "commandsRun", "commands_run")).map((command) => ({
    command: readString(command, "command")!,
    result: commandResult(readString(command, "result"))!,
    summary: readString(command, "summary")!,
  }));
  const validationOutput = stringArray(readAlias(report, "validationOutput", "validation_output"));
  const residualRisks = stringArray(readAlias(report, "residualRisks", "residual_risks"));
  const reviewFindings = stringArray(readAlias(report, "reviewFindings", "review_findings"));
  const noStagedFiles = readBooleanAlias(report, "noStagedFiles", "no_staged_files");
  const diffSummary = readStringAlias(report, "diffSummary", "diff_summary");
  const manualNotes = readStringAlias(report, "manualNotes", "manual_notes") ?? readString(report, "notes");
  if (
    criteria.length === 0 &&
    changedFiles.length === 0 &&
    tests.length === 0 &&
    commands.length === 0 &&
    validationOutput.length === 0 &&
    residualRisks.length === 0 &&
    reviewFindings.length === 0 &&
    noStagedFiles === undefined &&
    !diffSummary &&
    !manualNotes
  ) {
    return undefined;
  }
  return {
    satisfied: criteria.length > 0 && criteria.every((criterion) => criterion.status !== "not-satisfied"),
    criteria,
    changedFiles,
    tests,
    commands,
    validationOutput,
    residualRisks,
    reviewFindings,
    ...(noStagedFiles !== undefined ? { noStagedFiles } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    ...(manualNotes ? { manualNotes } : {}),
  };
}

function acceptanceSummary(report: AcceptanceReport): string {
  const parts = [report.satisfied ? "验收通过" : "验收结果待确认"];
  if (report.criteria.length > 0) parts.push(`${report.criteria.length} 项标准`);
  if (report.changedFiles.length > 0) parts.push(`${report.changedFiles.length} 个文件`);
  if (report.commands.length > 0) parts.push(`${report.commands.length} 项验证`);
  if (report.reviewFindings.length > 0) parts.push(`${report.reviewFindings.length} 项发现`);
  if (report.residualRisks.length > 0) parts.push(`${report.residualRisks.length} 项风险`);
  return parts.join(" · ");
}

function plainSummary(markdown: string): string {
  const firstContentLine = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) return "";
  return firstLineSummary(
    firstContentLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replaceAll("**", ""),
  );
}

function normalizeStatus(status: string | undefined): SubagentNotificationStatus {
  if (status === "failed") return "failed";
  if (status === "paused" || status === "stopped") return "paused";
  if (status === "running" || status === "pending") return "running";
  return "completed";
}

function statusLabel(status: SubagentNotificationStatus): string {
  if (status === "failed") return "失败";
  if (status === "paused") return "已暂停";
  if (status === "running") return "运行中";
  return "已完成";
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function isCompletionDetails(value: Readonly<Record<string, unknown>>): boolean {
  return typeof value.agent === "string" || typeof value.resultPreview === "string";
}

function parseJsonRecord(value: string): Readonly<Record<string, unknown>> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayRecords(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordArray(value: unknown): Readonly<Record<string, unknown>>[] {
  return isRecord(value) ? [value] : arrayRecords(value);
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAlias(record: Readonly<Record<string, unknown>>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function readStringAlias(record: Readonly<Record<string, unknown>>, camel: string, snake: string): string | undefined {
  return readString(record, camel) ?? readString(record, snake);
}

function readBooleanAlias(
  record: Readonly<Record<string, unknown>>,
  camel: string,
  snake: string,
): boolean | undefined {
  const value = readAlias(record, camel, snake);
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim().toLowerCase() === "true") return true;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return undefined;
}

function criterionStatus(criterion: Readonly<Record<string, unknown>>): AcceptanceCriterionStatus | undefined {
  const status = normalizedToken(readString(criterion, "status"));
  if (["not-applicable", "n-a", "na", "skip", "skipped"].includes(status)) return "not-applicable";
  if (
    ["satisfied", "met", "complete", "completed", "done", "pass", "passed", "success", "succeeded"].includes(status)
  ) {
    return "satisfied";
  }
  if (["not-satisfied", "not-met", "unmet", "incomplete", "fail", "failed"].includes(status)) {
    return "not-satisfied";
  }
  return undefined;
}

function commandResult(value: string | undefined): string | undefined {
  const token = normalizedToken(value);
  if (["passed", "pass", "success", "successful", "succeeded", "ok"].includes(token)) return "passed";
  if (["failed", "fail", "failure", "error"].includes(token)) return "failed";
  if (["not-run", "not-executed", "skip", "skipped"].includes(token)) return "not-run";
  return undefined;
}

function normalizedToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-") ?? ""
  );
}

function isValidAcceptanceShape(report: Readonly<Record<string, unknown>>): boolean {
  const knownFields = new Set([
    "criteriaSatisfied",
    "criteria_satisfied",
    "changedFiles",
    "changed_files",
    "testsAddedOrUpdated",
    "tests_added_or_updated",
    "commandsRun",
    "commands_run",
    "validationOutput",
    "validation_output",
    "residualRisks",
    "residual_risks",
    "noStagedFiles",
    "no_staged_files",
    "diffSummary",
    "diff_summary",
    "reviewFindings",
    "review_findings",
    "manualNotes",
    "manual_notes",
    "notes",
  ]);
  if (Object.keys(report).some((key) => !knownFields.has(key))) return false;
  for (const [camel, snake] of [
    ["criteriaSatisfied", "criteria_satisfied"],
    ["changedFiles", "changed_files"],
    ["testsAddedOrUpdated", "tests_added_or_updated"],
    ["commandsRun", "commands_run"],
    ["validationOutput", "validation_output"],
    ["residualRisks", "residual_risks"],
    ["noStagedFiles", "no_staged_files"],
    ["diffSummary", "diff_summary"],
    ["reviewFindings", "review_findings"],
    ["manualNotes", "manual_notes"],
  ] as const) {
    if (Object.hasOwn(report, camel) && Object.hasOwn(report, snake)) return false;
  }

  const criteriaValue = readAlias(report, "criteriaSatisfied", "criteria_satisfied");
  if (criteriaValue !== undefined) {
    const criteria = recordArray(criteriaValue);
    const expectedCount = Array.isArray(criteriaValue) ? criteriaValue.length : 1;
    if ((!isRecord(criteriaValue) && !Array.isArray(criteriaValue)) || criteria.length !== expectedCount) return false;
    const criterionIds = new Set<string>();
    for (const criterion of criteria) {
      if (
        Object.keys(criterion).some((key) => !["id", "status", "evidence"].includes(key)) ||
        (criterion.id !== undefined && typeof criterion.id !== "string") ||
        !criterionStatus(criterion) ||
        !readString(criterion, "evidence")
      ) {
        return false;
      }
      const criterionId = typeof criterion.id === "string" ? normalizedToken(criterion.id) : "";
      if (criterionId && criterionIds.has(criterionId)) return false;
      if (criterionId) criterionIds.add(criterionId);
    }
  }

  const commandsValue = readAlias(report, "commandsRun", "commands_run");
  if (commandsValue !== undefined) {
    const commands = recordArray(commandsValue);
    const expectedCount = Array.isArray(commandsValue) ? commandsValue.length : 1;
    if ((!isRecord(commandsValue) && !Array.isArray(commandsValue)) || commands.length !== expectedCount) return false;
    if (
      commands.some(
        (command) =>
          Object.keys(command).some((key) => !["command", "result", "summary"].includes(key)) ||
          !readString(command, "command") ||
          !commandResult(readString(command, "result")) ||
          !readString(command, "summary"),
      )
    ) {
      return false;
    }
  }

  for (const [camel, snake] of [
    ["changedFiles", "changed_files"],
    ["testsAddedOrUpdated", "tests_added_or_updated"],
    ["validationOutput", "validation_output"],
    ["residualRisks", "residual_risks"],
    ["reviewFindings", "review_findings"],
  ] as const) {
    const field = readAlias(report, camel, snake);
    if (field !== undefined && !validStringList(field)) return false;
  }
  const noStagedFiles = readAlias(report, "noStagedFiles", "no_staged_files");
  if (noStagedFiles !== undefined && readBooleanAlias(report, "noStagedFiles", "no_staged_files") === undefined) {
    return false;
  }
  const diffSummary = readAlias(report, "diffSummary", "diff_summary");
  if (diffSummary !== undefined && !readStringAlias(report, "diffSummary", "diff_summary")) return false;
  for (const key of ["manualNotes", "manual_notes", "notes"] as const) {
    if (report[key] !== undefined && typeof report[key] !== "string") return false;
  }
  return true;
}

function validStringList(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function hasGenericAcceptanceReportSignal(value: Readonly<Record<string, unknown>>): boolean {
  const report =
    ["acceptance", "acceptance-report", "acceptance_report", "acceptanceReport"]
      .map((key) => asRecord(value[key]))
      .find(Boolean) ?? value;
  const hasCriteria = report.criteriaSatisfied !== undefined || report.criteria_satisfied !== undefined;
  if (!hasCriteria) return false;
  return [
    ["changedFiles", "changed_files"],
    ["testsAddedOrUpdated", "tests_added_or_updated"],
    ["commandsRun", "commands_run"],
    ["validationOutput", "validation_output"],
    ["residualRisks", "residual_risks"],
    ["noStagedFiles", "no_staged_files"],
    ["diffSummary", "diff_summary"],
    ["reviewFindings", "review_findings"],
    ["manualNotes", "manual_notes"],
  ].some(([camel, snake]) => report[camel!] !== undefined || report[snake!] !== undefined);
}
