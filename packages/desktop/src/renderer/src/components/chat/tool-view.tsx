import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { followResizingContentToBottom } from "@renderer/shared/lib/follow-resizing-content-to-bottom";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import { ScrollArea } from "@renderer/shared/ui/scroll-area";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { useEffect, useRef, useState } from "react";
import { ToolFileTarget } from "./tool-file-target.tsx";
import { ToolContent } from "./tools/tool-content.tsx";
import { readToolStringArgument } from "./tools/tool-format.ts";

type ToolState = "running" | "complete" | "error";
type ToolTarget = { type: "file"; value: string } | { type: "text"; value: string };

interface ToolHeader {
  label: string;
  target?: ToolTarget;
  context?: string;
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
  const header = toolHeader(toolName, args);
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
            {header.target?.type !== "file" && header.context ? (
              <span className="tool-context">{header.context}</span>
            ) : null}
            {cursorFollowsArgs && header.target?.type !== "file" ? (
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
        <span className="sr-only" aria-live="polite">
          {stateLabel}
        </span>
        <CollapsibleTrigger
          className="tool-expand-trigger"
          aria-label={`${expanded ? "收起" : "展开"}${header.label}详情`}
        >
          <ChevronRight size={15} className="tool-chevron" aria-hidden="true" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="data-closed:animate-collapsible-up data-open:animate-collapsible-down overflow-hidden data-closed:pointer-events-none data-closed:fill-mode-forwards motion-reduce:animate-none">
        <ScrollArea className="tool-scroll-area" viewportRef={viewportRef}>
          <div ref={bodyRef} className="tool-body">
            <ToolContent
              name={toolName}
              args={args}
              result={displayedResult}
              error={error}
              expanded
              argsComplete={execution !== "streaming-args"}
            />
          </div>
        </ScrollArea>
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

function toolHeader(name: string, args: Readonly<Record<string, unknown>>): ToolHeader {
  const path = readToolStringArgument(args, "path", "file_path");
  if (name === "bash") {
    return { label: "$", target: textTarget(readToolStringArgument(args, "command") || "…") };
  }
  if (name === "read") {
    return { label: "read", target: fileTarget(path), context: readLineRange(args) };
  }
  if (name === "write" || name === "edit") {
    return { label: name, target: fileTarget(path) };
  }
  if (name === "grep") {
    const pattern = readToolStringArgument(args, "pattern");
    const glob = readToolStringArgument(args, "glob");
    return {
      label: "grep",
      target: textTarget(`/${pattern}/`),
      context: `in ${path || "."}${glob ? ` (${glob})` : ""}${numberSuffix(args.limit, "limit")}`,
    };
  }
  if (name === "find") {
    return {
      label: "find",
      target: textTarget(readToolStringArgument(args, "pattern") || "…"),
      context: `in ${path || "."}${numberSuffix(args.limit, "limit", true)}`,
    };
  }
  if (name === "ls") {
    return {
      label: "ls",
      target: textTarget(path || "."),
      context: numberSuffix(args.limit, "limit", true).trimStart(),
    };
  }
  return { label: name, target: textTarget(toolFallbackTarget(args)) };
}

function fileTarget(value: string): ToolTarget | undefined {
  return value ? { type: "file", value } : undefined;
}

function textTarget(value: string): ToolTarget {
  return { type: "text", value };
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
