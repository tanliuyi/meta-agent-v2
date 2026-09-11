import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { followResizingContentToBottom } from "@renderer/shared/lib/follow-resizing-content-to-bottom";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import { useDesktopSelector } from "@renderer/state/desktop-context";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { useEffect, useRef, useState } from "react";
import { ToolFileTarget } from "./tool-file-target.tsx";
import { MEMORY_SCOPE_LABELS } from "./tools/memory-content.tsx";
import { firstLineSummary, parseSubagentCall, parseSubagentDetails, summarizeAgents } from "./tools/subagent-format.ts";
import { ToolContent } from "./tools/tool-content.tsx";
import { parseToolResult, projectDisplayToolPath, readToolStringArgument } from "./tools/tool-format.ts";

type ToolState = "running" | "complete" | "error";
type ToolTarget = { type: "file"; value: string } | { type: "text"; value: string };

const TOOL_LABELS: Readonly<Record<string, string>> = {
  bash: "执行",
  powershell: "执行",
  read: "读取",
  write: "写入",
  edit: "编辑",
  grep: "搜索",
  find: "查找",
  ls: "列出",
  run_code: "调用插件",
  memory: "记忆",
  memory_search: "搜索记忆",
  session_search: "搜索会话",
  skill_manage: "管理技能",
  browser: "浏览器",
  subagent: "子智能体",
  subagent_wait: "子智能体",
  bg_wait: "等待任务",
  subagent_supervisor: "协调子智能体",
  compress: "压缩上下文",
  decompress: "恢复上下文",
  search_context: "搜索上下文",
  acp_status: "查看上下文",
  goal_complete: "完成目标",
  goal_blocked: "目标受阻",
  goal_wait: "等待目标",
};

interface ToolHeader {
  label: string;
  target?: ToolTarget;
  suffix?: string;
  context?: string;
  kind?: "skill";
}

/** 按 pi-coding-agent TUI 的标题、状态底色与折叠预览渲染工具。 */
export function ToolView({ toolName, args, result, status, artifact, isError }: ToolCallMessagePartProps) {
  const [expanded, setExpanded] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const artifactState = toolArtifact(artifact);
  const execution = artifactState?.execution;
  const running =
    status.type === "running" || execution === "streaming-args" || execution === "waiting" || execution === "running";
  const error = isError === true || execution === "error" || status.type === "incomplete";
  const toolState: ToolState = error ? "error" : running ? "running" : "complete";
  const displayedResult = result ?? artifactState?.partialResult;
  const projectCwd = useDesktopSelector(
    (state) => state.projects.find((project) => project.id === state.activeProjectId)?.cwd,
  );
  const header = toolHeader(toolName, args, projectCwd, displayedResult);
  const cursorFollowsArgs = running;
  const stateLabel = toolState === "running" ? "运行中" : toolState === "error" ? "失败" : "已完成";

  useEffect(() => {
    if (!expanded || !running) return;
    const viewport = viewportRef.current;
    const body = bodyRef.current;
    if (!viewport || !body) return;
    return followResizingContentToBottom(viewport, body, { respectUserScroll: true });
  }, [expanded, running]);

  return (
    <Collapsible
      className="tool-view"
      data-tool-name={toolName}
      data-tool-kind={header.kind}
      data-tool-status={toolState}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <div className="tool-trigger-row">
        <CollapsibleTrigger asChild>
          <button
            className="tool-trigger"
            data-running={running ? "true" : undefined}
            data-target-type={header.target?.type}
            type="button"
          >
            <span className="tool-name">{header.label}</span>
            {header.target?.type === "text" ? <span className="tool-target">{header.target.value}</span> : null}
            {header.suffix ? <span className="tool-suffix">{header.suffix}</span> : null}
            {header.target?.type !== "file" && header.context ? (
              <span className="tool-context">{header.context}</span>
            ) : null}
            {cursorFollowsArgs && header.kind !== "skill" && header.target?.type !== "file" ? (
              <span className="tool-running-cursor" aria-hidden="true" />
            ) : null}
          </button>
        </CollapsibleTrigger>
        {header.target?.type === "file" ? <ToolFileTarget path={header.target.value} /> : null}
        {header.target?.type === "file" && header.context ? (
          <span className="tool-context">{header.context}</span>
        ) : null}
        {cursorFollowsArgs && header.target?.type === "file" ? (
          <span className="tool-running-cursor" aria-hidden="true" />
        ) : null}
        {error ? (
          <span className="tool-error-label" aria-hidden="true">
            {toolName === "subagent" ? "调用失败" : "失败"}
          </span>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {stateLabel}
        </span>
        {header.kind !== "skill" ? (
          <CollapsibleTrigger
            className="tool-expand-trigger"
            aria-label={`${expanded ? "收起" : "展开"}${header.label}详情`}
          >
            <ChevronRight size={15} className="tool-chevron" aria-hidden="true" />
          </CollapsibleTrigger>
        ) : null}
      </div>
      <CollapsibleContent animation="persistent">
        <div className="tool-scroll-area" ref={viewportRef}>
          <div ref={bodyRef} className="tool-body">
            <ToolContent
              name={toolName}
              args={args}
              result={displayedResult}
              error={error}
              expanded
              argsComplete={execution !== "streaming-args"}
              artifact={artifact}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function toolArtifact(value: unknown): { execution?: string; partialResult?: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const execution = "execution" in value && typeof value.execution === "string" ? value.execution : undefined;
  const partialResult = "partialResult" in value ? value.partialResult : undefined;
  return { execution, partialResult };
}

function toolHeader(
  name: string,
  args: Readonly<Record<string, unknown>>,
  projectCwd?: string,
  result?: unknown,
): ToolHeader {
  const rawPath = readToolStringArgument(args, "path", "file_path");
  const path = projectCwd ? projectDisplayToolPath(rawPath, projectCwd) : rawPath;
  if (name === "bash" || name === "powershell") {
    return { label: toolLabel(name), target: textTarget(readToolStringArgument(args, "command") || "…") };
  }
  if (name === "read") {
    const skillName = readSkillName(path);
    if (skillName) {
      return { label: "加载", target: textTarget(skillName), suffix: "技能", kind: "skill" };
    }
    return { label: toolLabel(name), target: fileTarget(path), context: readLineRange(args) };
  }
  if (name === "write" || name === "edit") {
    return { label: toolLabel(name), target: fileTarget(path) };
  }
  if (name === "grep") {
    const pattern = readToolStringArgument(args, "pattern");
    const glob = readToolStringArgument(args, "glob");
    return {
      label: toolLabel(name),
      target: textTarget(`/${pattern}/`),
      context: `在 ${path || "."}${glob ? ` (${glob})` : ""}${numberSuffix(args.limit, "上限")}`,
    };
  }
  if (name === "find") {
    return {
      label: toolLabel(name),
      target: textTarget(readToolStringArgument(args, "pattern") || "…"),
      context: `在 ${path || "."}${numberSuffix(args.limit, "上限", true)}`,
    };
  }
  if (name === "ls") {
    return {
      label: toolLabel(name),
      target: textTarget(path || "."),
      context: numberSuffix(args.limit, "上限", true).trimStart(),
    };
  }
  if (name === "subagent" || name === "subagent_wait") return subagentToolHeader(name, args, result);
  if (name === "run_code") {
    return {
      label: toolLabel(name),
      target: textTarget(readToolStringArgument(args, "description") || "…"),
      context: result ? RunCodeContext(result) : undefined,
    };
  }

  if (name === "memory") {
    const actionLabel = MEMORY_ACTION_LABELS[readToolStringArgument(args, "action")];
    const scopeLabel = MEMORY_SCOPE_LABELS[readToolStringArgument(args, "target")];
    return {
      label: toolLabel(name),
      target: textTarget(firstLineSummary(readToolStringArgument(args, "content", "old_text")) || "…"),
      context: [actionLabel, scopeLabel].filter(Boolean).join(" · "),
    };
  }
  if (name === "memory_search") {
    return { label: toolLabel(name), target: textTarget(readToolStringArgument(args, "query") || "…") };
  }
  if (name === "session_search") {
    const query = readToolStringArgument(args, "query") || firstLineSummary(readToolStringArgument(args, "markdown"));
    return { label: toolLabel(name), target: textTarget(query || "…") };
  }
  if (name === "skill_manage") {
    return {
      label: toolLabel(name),
      target: textTarget(readToolStringArgument(args, "name", "skill_id") || "…"),
      context: SKILL_ACTION_LABELS[readToolStringArgument(args, "action")] ?? "",
    };
  }
  if (name === "browser" || name.startsWith("browser_")) {
    return browserToolHeader(name, args);
  }
  return {
    label: toolLabel(name),
    target: textTarget(TOOL_LABELS[name] ? toolFallbackTarget(args) : name),
    context: TOOL_LABELS[name] ? undefined : toolFallbackTarget(args),
  };
}

const BROWSER_ACTION_LABELS: Readonly<Record<string, string>> = {
  open: "打开",
  navigate: "导航",
  snapshot: "快照",
  screenshot: "截图",
  click: "点击",
  type: "输入",
  scroll: "滚动",
  back: "后退",
  forward: "前进",
  reload: "刷新",
  tabs: "标签页",
};

function browserToolHeader(name: string, args: Readonly<Record<string, unknown>>): ToolHeader {
  const action = name === "browser" ? "" : name.slice("browser_".length);
  const url = readToolStringArgument(args, "url");
  const tabId = typeof args.tabId === "number" ? String(args.tabId) : "";
  const elementIndex = typeof args.elementIndex === "number" ? `[${args.elementIndex}]` : "";
  const target = url || (tabId ? `标签页 ${tabId}` : elementIndex) || "…";
  const context = BROWSER_ACTION_LABELS[action] ?? "";
  return { label: toolLabel("browser"), target: textTarget(target), context: context || undefined };
}

const MEMORY_ACTION_LABELS: Readonly<Record<string, string>> = {
  add: "新增",
  replace: "更新",
  remove: "移除",
};

const SKILL_ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "创建技能",
  view: "查看技能",
  patch: "更新技能",
  update: "更新技能",
  edit: "更新技能",
  delete: "删除技能",
};

function RunCodeContext(result: unknown): string {
  const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
  if (!details || typeof details !== "object" || !("calls" in details) || !Array.isArray(details.calls)) return "";
  const active = details.calls.filter((call) => call && typeof call === "object" && call.state === "running").length;
  return active > 0 ? `${active} 个调用运行中` : `${details.calls.length} 个调用`;
}
function subagentToolHeader(name: string, args: Readonly<Record<string, unknown>>, result?: unknown): ToolHeader {
  const call = parseSubagentCall(name, args);
  const details = result === undefined ? undefined : parseSubagentDetails(parseToolResult(result)?.details);
  const liveRow = details?.rows.find((row) => row.status === "running");
  const liveStep = details?.steps?.find((step) => step.status === "running");
  const asyncSuffix = call.async ? " · 后台" : "";
  if (call.mode === "wait") {
    return {
      label: toolLabel(name),
      target: textTarget("等待"),
      context: call.waitId ? `等待 ${call.waitId}` : call.waitAll ? "等待全部后台任务" : "等待后台任务",
    };
  }
  if (call.mode === "management") {
    return { label: toolLabel(name), target: textTarget(call.action ?? "…"), context: call.actionTarget ?? "" };
  }
  // 运行中：标题跟随当前活动 agent / 步骤，实时反馈进度。
  if (call.mode === "chain" && liveStep) {
    return {
      label: toolLabel(name),
      target: textTarget(`串行 ${liveStep.stepIndex}/${details?.totalSteps ?? call.taskCount}`),
      context: `${liveStep.agents.join(" + ")}${asyncSuffix}`,
    };
  }
  if (liveRow && (call.mode === "parallel" || call.mode === "chain")) {
    return {
      label: toolLabel(name),
      target: textTarget(`${call.mode === "parallel" ? "并行" : "串行"} ×${call.taskCount}`),
      context: `${liveRow.agent}${liveRow.detail ? ` · ${liveRow.detail}` : ""}`,
    };
  }
  if (liveRow) {
    return {
      label: toolLabel(name),
      target: textTarget(liveRow.agent),
      context: liveRow.detail ?? `${firstLineSummary(call.specs[0]?.task ?? "")}${asyncSuffix}`,
    };
  }
  if (call.mode === "chain") {
    return {
      label: toolLabel(name),
      target: textTarget(`串行 ×${call.taskCount}`),
      context: `${summarizeAgents(call.specs, " → ")}${asyncSuffix}`,
    };
  }
  if (call.mode === "parallel") {
    return {
      label: toolLabel(name),
      target: textTarget(`并行 ×${call.taskCount}`),
      context: `${summarizeAgents(call.specs, ", ")}${asyncSuffix}`,
    };
  }
  const spec = call.specs[0];
  return {
    label: toolLabel(name),
    target: textTarget(spec?.agent ?? "…"),
    context: `${firstLineSummary(spec?.task ?? "")}${asyncSuffix}`,
  };
}

function toolLabel(name: string): string {
  if (name.startsWith("browser_")) return TOOL_LABELS.browser;
  return TOOL_LABELS[name] ?? "工具";
}

function fileTarget(value: string): ToolTarget | undefined {
  return value ? { type: "file", value } : undefined;
}

function textTarget(value: string): ToolTarget {
  return { type: "text", value };
}

function readSkillName(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.at(-1)?.toLowerCase() === "skill.md" ? segments.at(-2) : undefined;
}

function readLineRange(args: Readonly<Record<string, unknown>>): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
}

function numberSuffix(value: unknown, label: string, parentheses = false): string {
  if (typeof value !== "number") return "";
  const text = `${label} ${value}`;
  return parentheses ? ` (${text})` : ` ${text}`;
}

function toolFallbackTarget(args: Readonly<Record<string, unknown>>): string {
  for (const key of ["path", "file_path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}
