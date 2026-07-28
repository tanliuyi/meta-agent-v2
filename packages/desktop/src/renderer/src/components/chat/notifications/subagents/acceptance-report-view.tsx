import type { ReactNode } from "react";
import type { AcceptanceReport } from "./subagent-notification-data.ts";

export function AcceptanceReportView({ report }: { report: AcceptanceReport }) {
  return (
    <div className="builtin-acceptance-report">
      {report.criteria.length > 0 ? (
        <section className="builtin-notification-section">
          <h4>验收标准</h4>
          {report.criteria.map((criterion, index) => (
            <div
              className="builtin-acceptance-row"
              data-status={
                criterion.status === "satisfied"
                  ? "completed"
                  : criterion.status === "not-applicable"
                    ? "not-applicable"
                    : "failed"
              }
              key={`${criterion.id ?? "criterion"}:${index}`}
            >
              <span className="tool-subagent-status-dot" aria-hidden="true" />
              {criterion.id ? <strong>{criterion.id}</strong> : null}
              {criterion.status === "not-applicable" ? <small>不适用</small> : null}
              <span>{criterion.evidence}</span>
            </div>
          ))}
        </section>
      ) : null}
      {renderReportList("变更文件", report.changedFiles)}
      {renderReportList("新增或更新测试", report.tests)}
      {renderReportList("验证输出", report.validationOutput)}
      {report.commands.length > 0 ? (
        <section className="builtin-notification-section">
          <h4>验证结果</h4>
          {report.commands.map((command, index) => (
            <div className="builtin-acceptance-command" key={`${command.command}:${index}`}>
              <code>{command.command}</code>
              {command.result ? <span data-result={command.result}>{command.result}</span> : null}
              {command.summary ? <small>{command.summary}</small> : null}
            </div>
          ))}
        </section>
      ) : null}
      {renderReportList("审查发现", report.reviewFindings, "warning")}
      {renderReportList("剩余风险", report.residualRisks, "warning")}
      {report.diffSummary ? renderReportText("Diff 摘要", report.diffSummary) : null}
      {report.noStagedFiles !== undefined
        ? renderReportText("暂存区", report.noStagedFiles ? "没有暂存文件" : "存在暂存文件")
        : null}
      {report.manualNotes ? renderReportText("补充说明", report.manualNotes) : null}
    </div>
  );
}

function renderReportText(title: string, children: ReactNode): ReactNode {
  return (
    <section className="builtin-notification-section">
      <h4>{title}</h4>
      <p className="builtin-notification-detail">{children}</p>
    </section>
  );
}

function renderReportList(title: string, items: string[], tone?: "warning"): ReactNode {
  if (items.length === 0) return null;
  return (
    <section className="builtin-notification-section" data-tone={tone}>
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${index}:${item}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
