import { StreamdownMarkdown } from "@renderer/components/assistant-ui/streamdown/streamdown-markdown";
import type { ReactNode } from "react";
import type { SubagentAgentRow, SubagentCallSummary, SubagentChainStep } from "./subagent-format.ts";
import { parseSubagentCall, parseSubagentDetails } from "./subagent-format.ts";
import type { ToolContentProps } from "./tool-content-types.ts";
import { parseToolResult } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

const COLLAPSED_OUTPUT_LINES = 8;

/** 以任务列表、逐 agent 状态行与最终输出展示 subagent 运行，避免暴露原始 JSON。 */
export function SubagentContent({ name, args, result, error, expanded }: ToolContentProps) {
  const call = parseSubagentCall(name, args);
  const parsed = parseToolResult(result);
  const details = parseSubagentDetails(parsed?.details);
  const rows = details?.rows ?? [];
  const hasStructuredResult =
    rows.length > 0 ||
    Boolean(details?.asyncId) ||
    details?.timedOut === true ||
    details?.stopped === true ||
    Boolean(details?.summary) ||
    Boolean(details?.steps && details.steps.length > 0);
  const showPlainText =
    rows.length === 0 &&
    Boolean(parsed?.text.trim()) &&
    (call.mode === "management" || call.mode === "wait" || error || !hasStructuredResult);

  return (
    <>
      {renderCallSection(call)}
      {call.mode === "wait" && rows.length === 0 ? (
        <div className="tool-note">
          {call.waitId
            ? `等待后台任务 ${call.waitId} 完成`
            : call.waitAll
              ? "等待全部后台任务完成"
              : "等待首个后台任务完成"}
        </div>
      ) : null}
      {details?.steps && details.steps.length > 0 ? renderChainSteps(details.steps) : null}
      {rows.length > 0 ? (
        <div className="tool-subagent-section">{rows.map((row) => renderAgentRow(row, expanded))}</div>
      ) : null}
      {details?.asyncId && rows.length === 0 ? (
        <div className="tool-note">已在后台启动（ID: {details.asyncId}）</div>
      ) : null}
      {details?.timedOut ? (
        <div className="tool-note" data-tone="warning">
          运行超时，部分结果可能不完整
        </div>
      ) : null}
      {details?.stopped ? (
        <div className="tool-note" data-tone="warning">
          运行已被停止
        </div>
      ) : null}
      {details?.summary ? <div className="tool-subagent-summary">{details.summary}</div> : null}
      {showPlainText ? <ToolResult result={result} error={error} expanded={expanded} /> : null}
    </>
  );
}

function renderCallSection(call: SubagentCallSummary) {
  if (call.mode === "management") {
    return (
      <div className="tool-note">
        执行管理操作：{call.action}
        {call.actionTarget ? `（${call.actionTarget}）` : ""}
      </div>
    );
  }
  if (call.specs.length === 0) return null;
  return (
    <div className="tool-subagent-section">
      {call.specs.map((spec, index) => (
        <div className="tool-subagent-task" key={`${spec.step ?? ""}:${spec.agent}:${index}`}>
          {spec.step !== undefined ? <span className="tool-subagent-step">{spec.step}.</span> : null}
          <span className="tool-subagent-agent">
            {spec.agent}
            {spec.count !== undefined ? ` ×${spec.count}` : ""}
          </span>
          {spec.task ? <span className="tool-subagent-task-text">{spec.task}</span> : null}
        </div>
      ))}
      {call.async ? <div className="tool-note">异步执行，结果稍后返回</div> : null}
    </div>
  );
}

function renderChainSteps(steps: SubagentChainStep[]): ReactNode {
  return (
    <div className="tool-subagent-section">
      <div className="tool-subagent-section-label">执行链</div>
      {steps.map((step) => {
        const agents = step.isParallel ? `[${step.agents.join(" + ")}]` : (step.agents[0] ?? "…");
        return (
          <div className="tool-subagent-step-row" data-status={step.status} key={step.stepIndex}>
            <span className="tool-subagent-step">{step.stepIndex}.</span>
            <span className="tool-subagent-status-dot" aria-hidden="true" />
            <span className="tool-subagent-agent">{agents}</span>
            <span className="tool-subagent-status-label">{step.statusLabel}</span>
            {step.isParallel && step.agents.length > 1 ? (
              <span className="tool-subagent-detail">并行组 ×{step.agents.length}</span>
            ) : null}
            {step.error ? (
              <span className="tool-subagent-detail" data-tone="error">
                {step.error}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function renderAgentRow(row: SubagentAgentRow, expanded: boolean) {
  return (
    <div className="tool-subagent-agent-block" key={row.key}>
      <div className="tool-subagent-row" data-status={row.status} data-attention={row.attention ? "true" : undefined}>
        <span className="tool-subagent-status-dot" aria-hidden="true" />
        <span className="tool-subagent-agent">{row.agent}</span>
        <span className="tool-subagent-status-label">{row.statusLabel}</span>
        {row.detail ? <span className="tool-subagent-detail">{row.detail}</span> : null}
        {row.meta.length > 0 ? (
          <span className="tool-subagent-meta">
            {row.meta.map((item, index) => (
              <span className="tool-subagent-meta-chip" key={`${row.key}:${index}`}>
                {item}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {row.error ? <div className="tool-subagent-error">{row.error}</div> : null}
      {row.output ? renderOutput(row.output, expanded) : null}
    </div>
  );
}

function renderOutput(output: string, expanded: boolean) {
  const lines = output.replace(/\r/g, "").split("\n");
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_OUTPUT_LINES);
  const hiddenCount = lines.length - visibleLines.length;
  return (
    <div className="tool-output">
      <div className="px-2.5 py-2">
        <StreamdownMarkdown>{visibleLines.join("\n")}</StreamdownMarkdown>
      </div>
      {hiddenCount > 0 ? <div className="tool-output-truncation">… 另有 {hiddenCount} 行</div> : null}
    </div>
  );
}
