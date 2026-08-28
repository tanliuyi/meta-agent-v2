import type { OfficeDocumentPlan } from "../../../../../shared/office-document-contracts.ts";

export function DocxPlanDiff({ plan }: { plan: OfficeDocumentPlan }) {
  return (
    <div className="docx-plan-diff">
      {plan.semanticDiff.map((diff) => {
        if (diff.type === "cell-value") {
          return (
            <div key={`${diff.sheetId}-${diff.cellId}`}>
              <strong>修改单元格 {diff.address}</strong>
              {diff.before ? <del>{diff.before}</del> : null}
              {diff.after ? <ins>{diff.after}</ins> : null}
            </div>
          );
        }
        if (diff.type === "related-text") {
          return (
            <div key={`${diff.relatedPartId}-${diff.runId}`}>
              <strong>{diff.part === "header" ? "修改页眉" : "修改页脚"}</strong>
              {diff.before ? <del>{diff.before}</del> : null}
              {diff.after ? <ins>{diff.after}</ins> : null}
            </div>
          );
        }
        if (diff.type === "comment-text") {
          return (
            <div key={`${diff.commentId}-${diff.runId}`}>
              <strong>修改批注</strong>
              {diff.before ? <del>{diff.before}</del> : null}
              {diff.after ? <ins>{diff.after}</ins> : null}
            </div>
          );
        }
        if (diff.type === "run-style") {
          const changes = (["bold", "italic"] as const).filter(
            (property) => Boolean(diff.before[property]) !== Boolean(diff.after[property]),
          );
          return (
            <div key={`${diff.runId}-style`}>
              <strong>修改样式</strong>
              {changes.map((property) => (
                <span key={property}>
                  {property === "bold" ? "粗体" : "斜体"}：{diff.before[property] ? "开" : "关"} →{" "}
                  {diff.after[property] ? "开" : "关"}
                </span>
              ))}
            </div>
          );
        }
        if (diff.type === "paragraph") {
          return (
            <div key={`${diff.paragraphId}-${diff.change}`}>
              <strong>{diff.change === "insert" ? "插入段落" : "删除段落"}</strong>
              {diff.before ? <del>{diff.before}</del> : null}
              {diff.after ? <ins>{diff.after}</ins> : null}
            </div>
          );
        }
        return (
          <div key={diff.runId}>
            {diff.before ? <del>{diff.before}</del> : null}
            {diff.after ? <ins>{diff.after}</ins> : null}
          </div>
        );
      })}
    </div>
  );
}
