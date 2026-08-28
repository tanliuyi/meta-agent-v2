import {
  type CommitOfficeDocumentInput,
  type CommitOfficeDocumentResult,
  type DiscardOfficeDocumentPlanInput,
  type DocxEditorSource,
  type OfficeDocumentHandle,
  type OfficeDocumentInspection,
  type OfficeDocumentInspectionQuery,
  type OfficeDocumentPlan,
  type OfficeDocumentPreview,
  officeDocumentFormat,
  type PlanOfficeDocumentInput,
  type SaveDocxEditorInput,
  type SaveDocxEditorResult,
} from "../../shared/office-document-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { OfficeDocumentService, type OfficeDocumentServiceOptions } from "./office-document-service.ts";
import { XlsxDocumentService } from "./xlsx-document-service.ts";

const DEFAULT_MAX_OPEN_DOCUMENTS = 64;
const DEFAULT_MAX_OPEN_DOCUMENT_BYTES = 256 * 1024 * 1024;

export class NativeOfficeDocumentService {
  private readonly docx: OfficeDocumentService;
  private readonly xlsx: XlsxDocumentService;

  constructor(projects: ProjectStore, options: OfficeDocumentServiceOptions = {}) {
    const perFormatOptions: OfficeDocumentServiceOptions = {
      ...options,
      maxOpenDocuments: perFormatBudget(options.maxOpenDocuments, DEFAULT_MAX_OPEN_DOCUMENTS),
      maxOpenDocumentBytes: perFormatBudget(options.maxOpenDocumentBytes, DEFAULT_MAX_OPEN_DOCUMENT_BYTES),
    };
    this.docx = new OfficeDocumentService(projects, perFormatOptions);
    this.xlsx = new XlsxDocumentService(projects, perFormatOptions);
  }

  async open(ownerId: number, projectId: string, path: string): Promise<OfficeDocumentPreview> {
    const format = officeDocumentFormat(path);
    if (format === "xlsx") return this.xlsx.open(ownerId, projectId, path);
    if (format === "docx") return this.docx.open(ownerId, projectId, path);
    throw new Error("不是支持的原生 Office 文档格式");
  }
  getDocxEditorSource(ownerId: number, documentId: string): Promise<DocxEditorSource> {
    return this.docx.getEditorSource(ownerId, documentId);
  }
  saveDocxEditor(ownerId: number, input: SaveDocxEditorInput): Promise<SaveDocxEditorResult> {
    return this.docx.saveEditor(ownerId, input);
  }
  inspect(
    ownerId: number,
    documentId: string,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    if (!this.xlsx.has(documentId)) throw new Error("仅 XLSX 支持 renderer range inspection");
    return this.xlsx.inspect(ownerId, documentId, query);
  }
  listForAgent(projectId: string): OfficeDocumentHandle[] {
    return [...this.docx.listForAgent(projectId), ...this.xlsx.listForAgent(projectId)];
  }
  inspectForAgent(
    projectId: string,
    documentId: string,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    return this.xlsx.has(documentId)
      ? this.xlsx.inspectForAgent(projectId, documentId, query)
      : this.docx.inspectForAgent(projectId, documentId, query);
  }
  plan(ownerId: number, input: PlanOfficeDocumentInput): Promise<OfficeDocumentPlan> {
    return this.xlsx.has(input.documentId) ? this.xlsx.plan(ownerId, input) : this.docx.plan(ownerId, input);
  }
  planForAgent(projectId: string, input: PlanOfficeDocumentInput): Promise<OfficeDocumentPlan> {
    return this.xlsx.has(input.documentId)
      ? this.xlsx.planForAgent(projectId, input)
      : this.docx.planForAgent(projectId, input);
  }
  discard(ownerId: number, input: DiscardOfficeDocumentPlanInput): void {
    if (this.xlsx.has(input.documentId)) this.xlsx.discard(ownerId, input);
    else this.docx.discard(ownerId, input);
  }
  commit(ownerId: number, input: CommitOfficeDocumentInput): Promise<CommitOfficeDocumentResult> {
    return this.xlsx.has(input.documentId) ? this.xlsx.commit(ownerId, input) : this.docx.commit(ownerId, input);
  }
  closeOwner(ownerId: number): void {
    this.docx.closeOwner(ownerId);
    this.xlsx.closeOwner(ownerId);
  }
  closeProject(projectId: string): void {
    this.docx.closeProject(projectId);
    this.xlsx.closeProject(projectId);
  }
  dispose(): void {
    this.docx.dispose();
    this.xlsx.dispose();
  }
}

function perFormatBudget(configured: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor((configured ?? fallback) / 2));
}
