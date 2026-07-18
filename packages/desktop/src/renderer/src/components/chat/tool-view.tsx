import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ChevronRight, FileCode2, Files, ListTree, PencilLine, Search, TerminalSquare, Wrench } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ToolContent } from "./tools/tool-content.tsx";

type ToolState = "running" | "complete" | "error";

interface ToolViewDescription {
  icon: React.ReactNode;
  running: string;
  complete: string;
  error: string;
}

/** 按 Pi 原生工具类型渲染紧凑工具状态。 */
export function ToolView({ toolName, args, result, status, artifact, isError }: ToolCallMessagePartProps) {
  const view = toolView(toolName);
  const artifactState = toolArtifact(artifact);
  const execution = artifactState?.execution;
  const running =
    status.type === "running" || execution === "streaming-args" || execution === "waiting" || execution === "running";
  const error = isError === true || execution === "error" || status.type === "incomplete";
  const toolState: ToolState = error ? "error" : running ? "running" : "complete";
  const target = toolTarget(args);
  const displayedResult = result ?? artifactState?.partialResult;

  return (
    <Collapsible className="tool-view" data-tool-status={toolState}>
      <CollapsibleTrigger className="tool-trigger focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] focus-visible:ring-inset">
        <span className="tool-icon">{view.icon}</span>
        <span className={`tool-status-label ${toolState}`} aria-live="polite">
          {view[toolState]}
        </span>
        {target ? <span className="tool-target">{target}</span> : null}
        <ChevronRight size={16} className="tool-chevron" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-closed:animate-collapsible-up data-open:animate-collapsible-down overflow-hidden data-closed:pointer-events-none data-closed:fill-mode-forwards motion-reduce:animate-none">
        <div className="tool-body">
          <ToolContent name={toolName} args={args} result={displayedResult} error={error} />
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

function toolView(name: string): ToolViewDescription {
  if (name === "bash")
    return {
      running: "正在执行命令",
      complete: "已执行命令",
      error: "命令执行失败",
      icon: <TerminalSquare size={14} />,
    };
  if (name === "read")
    return { running: "正在读取", complete: "已读取", error: "读取失败", icon: <FileCode2 size={14} /> };
  if (name === "write")
    return { running: "正在写入", complete: "已写入", error: "写入失败", icon: <PencilLine size={14} /> };
  if (name === "edit")
    return { running: "正在编辑", complete: "已编辑", error: "编辑失败", icon: <PencilLine size={14} /> };
  if (name === "grep")
    return { running: "正在搜索", complete: "已搜索", error: "搜索失败", icon: <Search size={14} /> };
  if (name === "find") return { running: "正在查找", complete: "已查找", error: "查找失败", icon: <Files size={14} /> };
  if (name === "ls")
    return { running: "正在查看", complete: "已查看", error: "查看失败", icon: <ListTree size={14} /> };
  return { running: `正在运行 ${name}`, complete: `${name} 已完成`, error: `${name} 失败`, icon: <Wrench size={14} /> };
}

function toolTarget(args: Readonly<Record<string, unknown>>): string {
  for (const key of ["path", "file_path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}
