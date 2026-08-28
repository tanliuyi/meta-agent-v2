import type {
  DocumentOperationEnvelope,
  DocxBlockedReason,
  RelatedPartBlockedReason,
  ReplaceCommentTextRunOperation,
  ReplaceRelatedTextRunOperation,
  ReplaceTextRunOperation,
  SetCellValueOperation,
  XlsxOperationEnvelope,
} from "@earendil-works/pi-office-engine";

export type OfficeDocumentBlockedReason = DocxBlockedReason | RelatedPartBlockedReason;
export type ReplaceOfficeDocumentTextRunOperation = ReplaceTextRunOperation;
export type ReplaceOfficeDocumentRelatedTextRunOperation = ReplaceRelatedTextRunOperation;
export type ReplaceOfficeDocumentCommentTextRunOperation = ReplaceCommentTextRunOperation;
export type OfficeDocumentOperationEnvelope = DocumentOperationEnvelope | XlsxOperationEnvelope;
export type SetOfficeSpreadsheetCellValueOperation = SetCellValueOperation;
export type OfficeDocumentPartKind = "document" | "header" | "footer" | "comments";

export interface OfficeDocumentRunProperties {
  bold?: boolean;
  italic?: boolean;
  styleId?: string;
}

export interface OfficeDocumentTextRun {
  type: "text-run";
  id: string;
  text: string;
  properties: OfficeDocumentRunProperties;
  editable: boolean;
  blockedReason?: OfficeDocumentBlockedReason;
  textSha256: string;
}

export interface OfficeDocumentParagraph {
  type: "paragraph";
  id: string;
  part: OfficeDocumentPartKind;
  relatedPartId?: string;
  commentId?: string;
  commentAuthor?: string;
  runs: OfficeDocumentTextRun[];
  editable: boolean;
  blockedReason?: OfficeDocumentBlockedReason;
  textSha256: string;
}

export interface OfficeDocumentWarning {
  code: string;
  part: string;
  message: string;
}

export interface OfficeDocumentRelatedPart {
  id: string;
  kind: "header" | "footer";
  paragraphs: OfficeDocumentParagraph[];
  blocked: boolean;
}

export interface OfficeDocumentComment {
  id: string;
  author: string;
  date?: string;
  initials?: string;
  paragraphs: OfficeDocumentParagraph[];
  blocked: boolean;
}

export interface RenderDocumentNode {
  type: "document";
  children: OfficeDocumentParagraph[];
  relatedParts: OfficeDocumentRelatedPart[];
  comments: OfficeDocumentComment[];
}

export interface DocumentRenderTree {
  documentId: string;
  revision: number;
  format: "docx";
  root: RenderDocumentNode;
  warnings: OfficeDocumentWarning[];
}

export interface DocxDocumentPreview {
  kind: "docx";
  format: "docx";
  path: string;
  renderTree: DocumentRenderTree;
}

export interface DocxEditorSource {
  documentId: string;
  revision: number;
  sourceSha256: string;
  bytes: Uint8Array;
}

export interface SaveDocxEditorInput {
  documentId: string;
  revision: number;
  sourceSha256: string;
  bytes: Uint8Array;
}

export interface SaveDocxEditorResult {
  preview: DocxDocumentPreview;
}

export interface XlsxCell {
  id: string;
  address: string;
  value: string;
  valueSha256: string;
  valueType: "string" | "number" | "boolean" | "error" | "blank";
  editable: boolean;
  blockedReason?: "formula" | "unsupported-cell";
  styleId?: string;
}

export interface XlsxSheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellCount: number;
  truncated: boolean;
  cells: XlsxCell[];
}

export interface XlsxDocumentPreview {
  kind: "xlsx";
  format: "xlsx";
  path: string;
  documentId: string;
  revision: number;
  sheets: XlsxSheet[];
}

export interface LegacyOfficeDocumentPreview {
  kind: "legacy-html";
  format: "pptx";
  path: string;
  html: string;
}

export type OfficeDocumentPreview = DocxDocumentPreview | XlsxDocumentPreview | LegacyOfficeDocumentPreview;
export type OfficeDocumentFormat = OfficeDocumentPreview["format"];

export function officeDocumentFormat(path: string): OfficeDocumentFormat | undefined {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".docx")) return "docx";
  if (normalized.endsWith(".xlsx")) return "xlsx";
  if (normalized.endsWith(".pptx")) return "pptx";
  return undefined;
}

export interface OfficeDocumentHandle {
  documentId: string;
  path: string;
  format: "docx" | "xlsx";
  revision: number;
}

export interface InspectOfficeDocumentInput {
  documentId: string;
  query: OfficeDocumentInspectionQuery;
}

export type PlanOfficeDocumentInput =
  | { documentId: string; envelope: DocumentOperationEnvelope }
  | { documentId: string; envelope: XlsxOperationEnvelope };

export type OfficeDocumentSemanticDiff =
  | { type: "cell-value"; sheetId: string; cellId: string; address: string; before: string; after: string }
  | { type: "run-text"; runId: string; before: string; after: string }
  | {
      type: "related-text";
      part: "header" | "footer";
      relatedPartId: string;
      runId: string;
      before: string;
      after: string;
    }
  | {
      type: "comment-text";
      commentId: string;
      runId: string;
      before: string;
      after: string;
    }
  | {
      type: "run-style";
      runId: string;
      before: OfficeDocumentRunProperties;
      after: OfficeDocumentRunProperties;
    }
  | { type: "paragraph"; paragraphId: string; change: "insert" | "delete"; before: string; after: string };

export interface OfficeDocumentPlan {
  planId: string;
  documentId: string;
  baseRevision: number;
  resultingRevision: number;
  semanticDiff: OfficeDocumentSemanticDiff[];
  touchedRuns: string[];
  touchedParagraphs: string[];
  touchedCells?: string[];
  touchedParts: string[];
  warnings: OfficeDocumentWarning[];
  expiresAt: number;
  planSha256: string;
}

export interface CommitOfficeDocumentInput {
  documentId: string;
  planId: string;
  planSha256: string;
}

export interface DiscardOfficeDocumentPlanInput {
  documentId: string;
  planId: string;
}

export interface CommitOfficeDocumentResult {
  preview: DocxDocumentPreview | XlsxDocumentPreview;
  planSha256: string;
}

export type OfficeDocumentInspectionQuery =
  | { mode: "sheets"; limit?: number }
  | { mode: "cells"; sheetId: string; range?: string; limit?: number }
  | { mode: "search-cells"; text: string; sheetId?: string; limit?: number }
  | { mode: "outline"; limit?: number; parts?: OfficeDocumentPartKind[] }
  | { mode: "paragraphs"; paragraphIds: string[]; parts?: OfficeDocumentPartKind[] }
  | { mode: "search"; text: string; limit?: number; parts?: OfficeDocumentPartKind[] };

export interface OfficeDocumentParagraphOutline {
  id: string;
  part: OfficeDocumentPartKind;
  relatedPartId?: string;
  commentId?: string;
  commentAuthor?: string;
  editable: boolean;
  blockedReason?: OfficeDocumentBlockedReason;
  runCount: number;
  textPreview: string;
}

interface OfficeDocumentInspectionBase {
  documentId: string;
  path: string;
  revision: number;
  warnings: OfficeDocumentWarning[];
  truncated: boolean;
}

export interface OfficeDocumentOutlineInspection extends OfficeDocumentInspectionBase {
  mode: "outline";
  paragraphs: OfficeDocumentParagraphOutline[];
}

export interface OfficeDocumentParagraphInspection extends OfficeDocumentInspectionBase {
  mode: "paragraphs" | "search";
  paragraphs: OfficeDocumentParagraph[];
}

export interface XlsxDocumentInspection extends OfficeDocumentInspectionBase {
  mode: "sheets" | "cells" | "search-cells";
  sheets: Array<{ id: string; name: string; cellCount: number }>;
  cells: XlsxCell[];
}

export type OfficeDocumentInspection =
  | OfficeDocumentOutlineInspection
  | OfficeDocumentParagraphInspection
  | XlsxDocumentInspection;

export type OfficeDocumentHostRequest =
  | {
      type: "office-document.list";
      projectId: string;
    }
  | {
      type: "office-document.inspect";
      projectId: string;
      documentId: string;
      query: OfficeDocumentInspectionQuery;
    }
  | {
      type: "office-document.plan";
      projectId: string;
      input: PlanOfficeDocumentInput;
    };
