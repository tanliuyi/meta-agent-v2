import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  classifyIncomingDocxPlan,
  confirmDocxPlan,
  discardDocxPlan,
} from "../src/renderer/src/components/panel/files/docx-plan-actions.ts";
import { DocxPlanDiff } from "../src/renderer/src/components/panel/files/docx-plan-diff.tsx";
import type { DesktopApi } from "../src/shared/desktop-api.ts";
import type { DocxDocumentPreview, OfficeDocumentPlan } from "../src/shared/office-document-contracts.ts";

interface ElementProps {
  readonly children?: ReactNode;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isValidElement<ElementProps>(node) ? textContent(node.props.children) : "";
}

const preview: DocxDocumentPreview = {
  kind: "docx",
  format: "docx",
  path: "reports/quarterly.docx",
  renderTree: {
    documentId: "document-1",
    revision: 3,
    format: "docx",
    root: {
      type: "document",
      relatedParts: [],
      comments: [],
      children: [
        {
          type: "paragraph",
          part: "document",
          id: "paragraph-1",
          editable: true,
          textSha256: "paragraph-hash",
          runs: [
            {
              type: "text-run",
              id: "run-1",
              text: "One",
              textSha256: "run-hash",
              editable: true,
              properties: { bold: false, italic: false },
            },
          ],
        },
      ],
    },
    warnings: [],
  },
};

const plan: OfficeDocumentPlan = {
  planId: "plan-range",
  documentId: preview.renderTree.documentId,
  baseRevision: 3,
  resultingRevision: 4,
  semanticDiff: [{ runId: "run-1", before: "One", after: "O&" }],
  touchedRuns: ["run-1"],
  touchedParagraphs: [],
  touchedParts: ["word/document.xml"],
  warnings: [],
  expiresAt: 10_000,
  planSha256: "plan-hash",
};

type PlanFilesApi = Pick<DesktopApi["files"], "commitOfficeDocument" | "discardOfficeDocumentPlan">;

describe("DOCX approval boundary", () => {
  it("显示精确的 run 样式变化", () => {
    const tree = DocxPlanDiff({
      plan: {
        ...plan,
        semanticDiff: [
          {
            type: "run-style",
            runId: "run-1",
            before: { bold: false, italic: true },
            after: { bold: true, italic: false },
          },
        ],
      },
    });
    expect(textContent(tree)).toContain("修改样式粗体：关 → 开斜体：开 → 关");
  });

  it("只展示当前文档计划，并在本地内容未保存时丢弃", () => {
    expect(classifyIncomingDocxPlan("document-1", false, plan)).toBe("present");
    expect(classifyIncomingDocxPlan("document-1", true, plan)).toBe("discard");
    expect(classifyIncomingDocxPlan("other-document", false, plan)).toBe("ignore");
  });

  it("只有显式确认才提交精确计划句柄，取消只丢弃当前计划", async () => {
    const updatedPreview = { ...preview, renderTree: { ...preview.renderTree, revision: 4 } };
    const commitOfficeDocument = vi.fn(async () => ({ preview: updatedPreview }));
    const discardOfficeDocumentPlan = vi.fn(async () => undefined);
    const files: PlanFilesApi = { commitOfficeDocument, discardOfficeDocumentPlan };

    expect(commitOfficeDocument).not.toHaveBeenCalled();
    expect(await confirmDocxPlan(files, preview.renderTree.documentId, plan)).toBe(updatedPreview);
    expect(commitOfficeDocument).toHaveBeenCalledWith({
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });

    await discardDocxPlan(files, preview.renderTree.documentId, plan);
    expect(discardOfficeDocumentPlan).toHaveBeenCalledWith({
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
    });
  });
});
