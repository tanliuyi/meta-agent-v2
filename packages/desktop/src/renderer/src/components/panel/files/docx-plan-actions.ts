import type { DesktopApi } from "../../../../../shared/desktop-api.ts";
import type { DocxDocumentPreview, OfficeDocumentPlan } from "../../../../../shared/office-document-contracts.ts";

type OfficeDocumentFilesApi = Pick<DesktopApi["files"], "commitOfficeDocument" | "discardOfficeDocumentPlan">;

export type IncomingDocxPlanAction = "ignore" | "present" | "discard";

export function classifyIncomingDocxPlan(
  documentId: string,
  dirty: boolean,
  plan: OfficeDocumentPlan,
): IncomingDocxPlanAction {
  if (plan.documentId !== documentId) return "ignore";
  return dirty ? "discard" : "present";
}

export async function confirmDocxPlan(
  files: OfficeDocumentFilesApi,
  documentId: string,
  plan: OfficeDocumentPlan,
): Promise<DocxDocumentPreview> {
  const result = await files.commitOfficeDocument({
    documentId,
    planId: plan.planId,
    planSha256: plan.planSha256,
  });
  if (result.preview.kind !== "docx") throw new Error("DOCX 保存结果格式无效");
  return result.preview;
}

export async function discardDocxPlan(
  files: OfficeDocumentFilesApi,
  documentId: string,
  plan: OfficeDocumentPlan,
): Promise<void> {
  await files.discardOfficeDocumentPlan({ documentId, planId: plan.planId });
}
