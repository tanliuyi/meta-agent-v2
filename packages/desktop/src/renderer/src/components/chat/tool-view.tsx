import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  Check,
  ChevronRight,
  FileCode2,
  Files,
  ListTree,
  PencilLine,
  Search,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { useToolUpdate } from "../../runtime/tool-status-store.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ToolContent } from "./tools/tool-content.tsx";

/** 按 Pi 原生工具类型渲染紧凑工具状态。 */
export function ToolView({ toolCallId, toolName, args, result, status }: ToolCallMessagePartProps) {
  const view = toolView(toolName);
  const update = useToolUpdate(toolCallId);
  const running = update ? update.status === "running" : status.type === "running";
  const error = update ? update.status === "error" : status.type === "incomplete";
  const displayedResult = update?.result ?? result;

  return (
    <Collapsible className="tool-view">
      <CollapsibleTrigger className="tool-trigger focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px] focus-visible:ring-inset">
        <span className="tool-icon">{view.icon}</span>
        <span className="tool-name">{view.label}</span>
        <span className="tool-target">{toolTarget(args)}</span>
        <span className={`tool-status ${running ? "running" : error ? "error" : "complete"}`}>
          {running ? <span className="spinner" /> : error ? <X size={13} /> : <Check size={13} />}
        </span>
        <ChevronRight size={13} className="tool-chevron" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-closed:animate-collapsible-up data-open:animate-collapsible-down overflow-hidden data-closed:pointer-events-none data-closed:fill-mode-forwards motion-reduce:animate-none">
        <div className="tool-body">
          <ToolContent name={toolName} args={args} result={displayedResult} error={error} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function toolView(name: string): { label: string; icon: React.ReactNode } {
  if (name === "bash") return { label: "运行命令", icon: <TerminalSquare size={14} /> };
  if (name === "read") return { label: "读取文件", icon: <FileCode2 size={14} /> };
  if (name === "write") return { label: "写入文件", icon: <PencilLine size={14} /> };
  if (name === "edit") return { label: "编辑文件", icon: <PencilLine size={14} /> };
  if (name === "grep") return { label: "搜索内容", icon: <Search size={14} /> };
  if (name === "find") return { label: "查找文件", icon: <Files size={14} /> };
  if (name === "ls") return { label: "列出目录", icon: <ListTree size={14} /> };
  return { label: name, icon: <Wrench size={14} /> };
}

function toolTarget(args: Readonly<Record<string, unknown>>): string {
  for (const key of ["path", "file_path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}
