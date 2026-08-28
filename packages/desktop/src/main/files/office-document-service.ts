import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import {
  commitDocx,
  type DocumentPlan,
  type DocxInspectSnapshot,
  type DocxParagraphSnapshot,
  inspectDocx,
  PackageArchive,
  planDocx,
  type RelatedPartParagraphSnapshot,
  sha256Hex,
} from "@earendil-works/pi-office-engine";
import type {
  CommitOfficeDocumentInput,
  CommitOfficeDocumentResult,
  DiscardOfficeDocumentPlanInput,
  DocxDocumentPreview,
  DocxEditorSource,
  OfficeDocumentHandle,
  OfficeDocumentInspection,
  OfficeDocumentInspectionQuery,
  OfficeDocumentParagraph,
  OfficeDocumentPartKind,
  OfficeDocumentPlan,
  PlanOfficeDocumentInput,
  SaveDocxEditorInput,
  SaveDocxEditorResult,
} from "../../shared/office-document-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { replaceFileAtomically } from "./atomic-file-replacement.ts";
import { officeTransactionAuditErrorCode } from "./office-transaction-audit.ts";
import { normalizeProjectRelativePath, resolveProjectFilePath } from "./project-file-path.ts";

const PLAN_TTL_MS = 5 * 60_000;
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OPEN_DOCUMENTS = 64;
const DEFAULT_MAX_OPEN_DOCUMENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_DOCUMENT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
const MAX_INSPECTION_PARAGRAPHS = 50;
const MAX_INSPECTION_TEXT_CHARS = 20_000;
const OUTLINE_PREVIEW_CHARS = 160;

interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface OpenDocument {
  ownerId: number;
  projectId: string;
  path: string;
  absolutePath: string;
  archive: PackageArchive;
  snapshot: DocxInspectSnapshot;
  fingerprint: SourceFingerprint;
  byteSize: number;
  lastAccessedAt: number;
}

interface InspectionParagraph {
  paragraph: DocxParagraphSnapshot | RelatedPartParagraphSnapshot;
  part: OfficeDocumentPartKind;
  relatedPartId?: string;
  commentId?: string;
  commentAuthor?: string;
}

type DocxInspectionQuery = Extract<OfficeDocumentInspectionQuery, { mode: "outline" | "paragraphs" | "search" }>;

interface PendingPlan {
  ownerId: number;
  documentId: string;
  planId: string;
  createdAt: number;
  snapshot: DocxInspectSnapshot;
  plan: DocumentPlan;
}

export interface OfficeDocumentTransactionAudit {
  transactionId: string;
  projectId: string;
  relativePath: string;
  format: "docx" | "xlsx";
  sourceSha256: string;
  outputSha256?: string;
  operationTypes: string[];
  operationCount: number;
  touchedParts: string[];
  planSha256: string;
  approvedAt?: number;
  approvalChannel?: "renderer_user";
  status: "planned" | "approved" | "rejected" | "committed" | "stale" | "failed";
  createdAt: number;
  completedAt?: number;
  errorCode?: string;
}

export interface OfficeDocumentServiceOptions {
  onPlanCreated?(ownerId: number, plan: OfficeDocumentPlan): void;
  onAudit?(audit: OfficeDocumentTransactionAudit): void;
  maxOpenDocuments?: number;
  maxOpenDocumentBytes?: number;
  idleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  now?: () => number;
}

export class OfficeDocumentService {
  private readonly projects: ProjectStore;
  private readonly onPlanCreated?: OfficeDocumentServiceOptions["onPlanCreated"];
  private readonly onAudit?: OfficeDocumentServiceOptions["onAudit"];
  private readonly maxOpenDocuments: number;
  private readonly maxOpenDocumentBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly idleSweepTimer: ReturnType<typeof setInterval>;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly plans = new Map<string, PendingPlan>();
  private readonly committingPaths = new Set<string>();
  private readonly ownerGenerations = new Map<number, number>();

  constructor(projects: ProjectStore, options: OfficeDocumentServiceOptions = {}) {
    this.projects = projects;
    this.onPlanCreated = options.onPlanCreated;
    this.onAudit = options.onAudit;
    this.maxOpenDocuments = positiveInteger(options.maxOpenDocuments, DEFAULT_MAX_OPEN_DOCUMENTS);
    this.maxOpenDocumentBytes = positiveInteger(options.maxOpenDocumentBytes, DEFAULT_MAX_OPEN_DOCUMENT_BYTES);
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_DOCUMENT_IDLE_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    const sweepIntervalMs = positiveInteger(options.idleSweepIntervalMs, DEFAULT_IDLE_SWEEP_INTERVAL_MS);
    this.idleSweepTimer = setInterval(() => this.collectIdleDocuments(), sweepIntervalMs);
    this.idleSweepTimer.unref?.();
  }

  async open(ownerId: number, projectId: string, path: string): Promise<DocxDocumentPreview> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !projectId || typeof path !== "string") {
      throw new TypeError("Office 文档打开参数无效");
    }
    const ownerGeneration = this.ownerGeneration(ownerId);
    const cwd = await realpath(this.projects.getCwd(projectId));
    const requestedPath = resolveProjectFilePath(cwd, path);
    const absolutePath = await realpath(requestedPath);
    resolveProjectFilePath(cwd, absolutePath);
    if (extname(absolutePath).toLowerCase() !== ".docx") throw new Error("不是 DOCX 文档");
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > MAX_DOCX_BYTES) throw new Error("DOCX 文档超过 50 MiB 限制");
    const bytes = await readFile(absolutePath);
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error("DOCX 文档超过 50 MiB 限制");
    const archive = PackageArchive.open(bytes);
    const documentId = randomUUID();
    const snapshot = inspectDocx(archive, documentId);
    const normalizedPath = normalizeProjectRelativePath(relative(cwd, absolutePath));
    this.assertOwnerGeneration(ownerId, ownerGeneration);
    for (const [existingId, existing] of this.documents) {
      if (existing.ownerId === ownerId && existing.projectId === projectId && existing.path === normalizedPath) {
        this.removeDocument(existingId);
      }
    }
    const openedAt = this.now();
    this.ensureCapacity(bytes.byteLength);
    const document: OpenDocument = {
      ownerId,
      projectId,
      path: normalizedPath,
      absolutePath,
      archive,
      snapshot,
      fingerprint: { size: info.size, mtimeMs: info.mtimeMs, sha256: snapshot.sourceSha256 },
      byteSize: bytes.byteLength,
      lastAccessedAt: openedAt,
    };
    this.documents.set(documentId, document);
    return toPreview(document);
  }

  async getEditorSource(ownerId: number, documentId: string): Promise<DocxEditorSource> {
    const document = this.getDocument(ownerId, documentId);
    await this.assertCurrent(document);
    return {
      documentId,
      revision: document.snapshot.revision,
      sourceSha256: document.fingerprint.sha256,
      bytes: await readFile(document.absolutePath),
    };
  }

  async saveEditor(ownerId: number, input: SaveDocxEditorInput): Promise<SaveDocxEditorResult> {
    if (
      !input ||
      typeof input.documentId !== "string" ||
      !Number.isSafeInteger(input.revision) ||
      typeof input.sourceSha256 !== "string" ||
      !(input.bytes instanceof Uint8Array)
    ) {
      throw new TypeError("DOCX 编辑器保存参数无效");
    }
    if (input.bytes.byteLength > MAX_DOCX_BYTES) throw new Error("DOCX 文档超过 50 MiB 限制");
    const document = this.getDocument(ownerId, input.documentId);
    this.projects.getCwd(document.projectId);
    if (document.snapshot.revision !== input.revision || document.fingerprint.sha256 !== input.sourceSha256) {
      throw new Error("STALE_DOCUMENT");
    }
    if (this.committingPaths.has(document.absolutePath)) throw new Error("Office 文档正在保存");

    this.committingPaths.add(document.absolutePath);
    try {
      await this.assertCurrent(document);
      const archive = PackageArchive.open(input.bytes);
      const snapshot = inspectDocx(archive, document.snapshot.documentId, document.snapshot.revision + 1);
      this.ensureCapacity(input.bytes.byteLength, document.snapshot.documentId);
      await replaceFileAtomically(document.absolutePath, input.sourceSha256, input.bytes);
      const refreshedInfo = await stat(document.absolutePath);
      document.archive = archive;
      document.snapshot = snapshot;
      document.fingerprint = {
        size: refreshedInfo.size,
        mtimeMs: refreshedInfo.mtimeMs,
        sha256: snapshot.sourceSha256,
      };
      document.byteSize = input.bytes.byteLength;
      document.lastAccessedAt = this.now();
      this.deleteDocumentPlans(document.snapshot.documentId);
      return { preview: toPreview(document) };
    } finally {
      this.committingPaths.delete(document.absolutePath);
    }
  }

  listForAgent(projectId: string): OfficeDocumentHandle[] {
    this.collectIdleDocuments();
    this.projects.getCwd(projectId);
    return [...this.documents.values()]
      .filter((document) => document.projectId === projectId)
      .map((document) => ({
        documentId: document.snapshot.documentId,
        path: document.path,
        format: "docx" as const,
        revision: document.snapshot.revision,
      }));
  }

  async inspectForAgent(
    projectId: string,
    documentId: string,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    const document = this.getProjectDocument(projectId, documentId);
    await this.assertCurrent(document);
    if (query.mode === "sheets" || query.mode === "cells" || query.mode === "search-cells") {
      throw new TypeError("Office 文档检查查询无效");
    }
    const limit = inspectionLimit(query);
    const selected = selectInspectionParagraphs(document.snapshot, query, limit);
    if (query.mode === "outline") {
      return {
        mode: "outline",
        ...inspectionBase(document, selected.truncated),
        paragraphs: selected.paragraphs.map(({ paragraph, part, relatedPartId, commentId, commentAuthor }) => ({
          id: paragraph.id,
          part,
          ...(relatedPartId ? { relatedPartId } : {}),
          ...(commentId ? { commentId } : {}),
          ...(commentAuthor ? { commentAuthor } : {}),
          editable: paragraph.editable,
          ...(paragraph.blockedReason ? { blockedReason: paragraph.blockedReason } : {}),
          runCount: paragraph.runs.length,
          textPreview: paragraphText(paragraph).slice(0, OUTLINE_PREVIEW_CHARS),
        })),
      };
    }
    let textChars = 0;
    const paragraphs: OfficeDocumentParagraph[] = [];
    let truncated = selected.truncated;
    for (const selectedParagraph of selected.paragraphs) {
      const textLength = paragraphText(selectedParagraph.paragraph).length;
      if (textChars + textLength > MAX_INSPECTION_TEXT_CHARS) {
        truncated = true;
        break;
      }
      paragraphs.push(
        toParagraph(selectedParagraph.paragraph, selectedParagraph.part, {
          relatedPartId: selectedParagraph.relatedPartId,
          commentId: selectedParagraph.commentId,
          commentAuthor: selectedParagraph.commentAuthor,
        }),
      );
      textChars += textLength;
    }
    return { mode: query.mode, ...inspectionBase(document, truncated), paragraphs };
  }

  async plan(ownerId: number, input: PlanOfficeDocumentInput, now = this.now()): Promise<OfficeDocumentPlan> {
    validatePlanInput(input);
    const ownerGeneration = this.ownerGeneration(ownerId);
    const document = this.getDocument(ownerId, input.documentId);
    const result = await this.createPlan(document, input, now);
    try {
      this.assertOwnerGeneration(ownerId, ownerGeneration);
      if (this.documents.get(input.documentId) !== document) throw new Error("Office 文档窗口已关闭");
    } catch (error) {
      this.plans.delete(result.planId);
      throw error;
    }
    return result;
  }

  async planForAgent(projectId: string, input: PlanOfficeDocumentInput, now = this.now()): Promise<OfficeDocumentPlan> {
    validatePlanInput(input);
    const document = this.getProjectDocument(projectId, input.documentId);
    const ownerGeneration = this.ownerGeneration(document.ownerId);
    const result = await this.createPlan(document, input, now);
    try {
      this.assertOwnerGeneration(document.ownerId, ownerGeneration);
      if (this.documents.get(input.documentId) !== document) throw new Error("Office 文档窗口已关闭");
    } catch (error) {
      this.plans.delete(result.planId);
      throw error;
    }
    this.onPlanCreated?.(document.ownerId, result);
    return result;
  }

  discard(ownerId: number, input: DiscardOfficeDocumentPlanInput): void {
    if (!input || typeof input.documentId !== "string" || typeof input.planId !== "string") {
      throw new TypeError("Office 文档计划取消参数无效");
    }
    const document = this.getDocument(ownerId, input.documentId);
    const pending = this.plans.get(input.planId);
    if (!pending || pending.ownerId !== ownerId || pending.documentId !== input.documentId) {
      throw new Error("无效的 Office 文档计划句柄");
    }
    this.plans.delete(input.planId);
    this.writeAudit(document, pending, "rejected", this.now());
  }

  async commit(
    ownerId: number,
    input: CommitOfficeDocumentInput,
    now = this.now(),
  ): Promise<CommitOfficeDocumentResult> {
    validateCommitInput(input);
    const document = this.getDocument(ownerId, input.documentId);
    this.projects.getCwd(document.projectId);
    const pending = this.plans.get(input.planId);
    if (!pending || pending.ownerId !== ownerId || pending.documentId !== input.documentId) {
      throw new Error("无效的 Office 文档计划句柄");
    }
    this.plans.delete(input.planId);
    let ownsCommitLock = false;
    let approved = false;
    try {
      if (pending.plan.planSha256 !== input.planSha256) throw new Error("Office 文档计划校验失败");
      approved = true;
      this.writeAudit(document, pending, "approved", now, undefined, true);
      if (this.committingPaths.has(document.absolutePath)) throw new Error("Office 文档正在保存");
      this.committingPaths.add(document.absolutePath);
      ownsCommitLock = true;
      await this.assertCurrent(document);
      const output = commitDocx(document.archive, pending.snapshot, pending.plan, now);
      this.ensureCapacity(output.byteLength, document.snapshot.documentId);
      await replaceFileAtomically(document.absolutePath, pending.plan.sourceSha256, output);
      const archive = PackageArchive.open(output);
      const snapshot = inspectDocx(archive, document.snapshot.documentId, pending.plan.resultingRevision);
      const refreshedInfo = await stat(document.absolutePath);
      document.archive = archive;
      document.snapshot = snapshot;
      document.fingerprint = {
        size: refreshedInfo.size,
        mtimeMs: refreshedInfo.mtimeMs,
        sha256: snapshot.sourceSha256,
      };
      document.byteSize = output.byteLength;
      document.lastAccessedAt = this.now();
      this.deleteDocumentPlans(document.snapshot.documentId);
      this.writeAudit(document, pending, "committed", now, undefined, true);
      return { preview: toPreview(document), planSha256: pending.plan.planSha256 };
    } catch (error) {
      const errorCode = officeTransactionAuditErrorCode(error);
      this.writeAudit(document, pending, errorCode === "STALE_DOCUMENT" ? "stale" : "failed", now, errorCode, approved);
      throw error;
    } finally {
      if (ownsCommitLock) this.committingPaths.delete(document.absolutePath);
    }
  }

  closeOwner(ownerId: number): void {
    this.ownerGenerations.set(ownerId, this.ownerGeneration(ownerId) + 1);
    for (const [documentId, document] of this.documents) {
      if (document.ownerId === ownerId) this.removeDocument(documentId);
    }
  }

  closeProject(projectId: string): void {
    for (const [documentId, document] of this.documents) {
      if (document.projectId === projectId) this.removeDocument(documentId);
    }
  }

  dispose(): void {
    clearInterval(this.idleSweepTimer);
    this.documents.clear();
    this.plans.clear();
    this.committingPaths.clear();
  }

  private async createPlan(
    document: OpenDocument,
    input: PlanOfficeDocumentInput,
    now: number,
  ): Promise<OfficeDocumentPlan> {
    await this.assertCurrent(document);
    const plan = planDocx(document.archive, document.snapshot, input.envelope, now + PLAN_TTL_MS, now);
    const planId = randomUUID();
    this.deleteDocumentPlans(input.documentId);
    const pending = {
      ownerId: document.ownerId,
      documentId: input.documentId,
      planId,
      createdAt: now,
      snapshot: document.snapshot,
      plan,
    };
    this.plans.set(planId, pending);
    this.writeAudit(document, pending, "planned", now);
    return { planId, ...publicPlan(plan) };
  }

  private getDocument(ownerId: number, documentId: string): OpenDocument {
    this.collectIdleDocuments();
    const document = this.documents.get(documentId);
    if (!document || document.ownerId !== ownerId) throw new Error("Office 文档会话不存在");
    document.lastAccessedAt = this.now();
    return document;
  }

  private getProjectDocument(projectId: string, documentId: string): OpenDocument {
    this.collectIdleDocuments();
    const document = this.documents.get(documentId);
    if (!document || document.projectId !== projectId) throw new Error("Office 文档会话不存在");
    this.projects.getCwd(projectId);
    document.lastAccessedAt = this.now();
    return document;
  }

  private async assertCurrent(document: OpenDocument): Promise<void> {
    const currentInfo = await stat(document.absolutePath);
    const current = await readFile(document.absolutePath);
    const currentSha256 = sha256Hex(current);
    if (currentSha256 !== document.fingerprint.sha256) throw new Error("STALE_DOCUMENT");
    if (currentInfo.size !== current.byteLength) throw new Error("STALE_DOCUMENT");
    document.fingerprint = { size: currentInfo.size, mtimeMs: currentInfo.mtimeMs, sha256: currentSha256 };
  }

  private deleteDocumentPlans(documentId: string): void {
    for (const [planId, plan] of this.plans) {
      if (plan.documentId === documentId) this.plans.delete(planId);
    }
  }

  private removeDocument(documentId: string): void {
    this.documents.delete(documentId);
    this.deleteDocumentPlans(documentId);
  }

  private collectIdleDocuments(): void {
    const expiredBefore = this.now() - this.idleTimeoutMs;
    for (const [documentId, document] of this.documents) {
      if (document.lastAccessedAt <= expiredBefore && !this.committingPaths.has(document.absolutePath)) {
        this.removeDocument(documentId);
      }
    }
  }

  private ensureCapacity(byteSize: number, replacingDocumentId?: string): void {
    this.collectIdleDocuments();
    while (
      this.documents.size + (replacingDocumentId ? 0 : 1) > this.maxOpenDocuments ||
      this.openDocumentBytes() -
        (replacingDocumentId ? (this.documents.get(replacingDocumentId)?.byteSize ?? 0) : 0) +
        byteSize >
        this.maxOpenDocumentBytes
    ) {
      const candidate = [...this.documents.entries()]
        .filter(
          ([documentId, document]) =>
            documentId !== replacingDocumentId && !this.committingPaths.has(document.absolutePath),
        )
        .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)[0];
      if (!candidate) throw new Error("Office 文档缓存容量不足");
      this.removeDocument(candidate[0]);
    }
  }

  private openDocumentBytes(): number {
    let total = 0;
    for (const document of this.documents.values()) total += document.byteSize;
    return total;
  }

  private writeAudit(
    document: OpenDocument,
    pending: PendingPlan,
    status: OfficeDocumentTransactionAudit["status"],
    now: number,
    errorCode?: string,
    approved = false,
  ): void {
    const completed = status === "rejected" || status === "committed" || status === "stale" || status === "failed";
    const audit: OfficeDocumentTransactionAudit = {
      transactionId: pending.planId,
      projectId: document.projectId,
      relativePath: document.path,
      format: "docx",
      sourceSha256: pending.plan.sourceSha256,
      ...(status === "committed" ? { outputSha256: document.snapshot.sourceSha256 } : {}),
      operationTypes: pending.plan.envelope.operations.map((operation) => operation.type),
      operationCount: pending.plan.envelope.operations.length,
      touchedParts: [...pending.plan.touchedParts],
      planSha256: pending.plan.planSha256,
      ...(approved ? { approvedAt: now, approvalChannel: "renderer_user" as const } : {}),
      status,
      createdAt: pending.createdAt,
      ...(completed ? { completedAt: now } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
    try {
      this.onAudit?.(audit);
    } catch {
      // 审计输出失败不能改变已经确定的事务结果。
    }
  }

  private ownerGeneration(ownerId: number): number {
    return this.ownerGenerations.get(ownerId) ?? 0;
  }

  private assertOwnerGeneration(ownerId: number, expected: number): void {
    if (this.ownerGeneration(ownerId) !== expected) throw new Error("Office 文档窗口已关闭");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Office 文档服务资源限制无效");
  return value;
}

function validatePlanInput(input: PlanOfficeDocumentInput): void {
  if (
    !input ||
    typeof input.documentId !== "string" ||
    !input.envelope ||
    input.envelope.protocolVersion !== 1 ||
    !Array.isArray(input.envelope.operations)
  ) {
    throw new TypeError("Office 文档计划参数无效");
  }
}

function validateCommitInput(input: CommitOfficeDocumentInput): void {
  if (
    !input ||
    typeof input.documentId !== "string" ||
    typeof input.planId !== "string" ||
    typeof input.planSha256 !== "string"
  ) {
    throw new TypeError("Office 文档提交参数无效");
  }
}

function inspectionLimit(query: DocxInspectionQuery): number {
  if (!query || (query.mode !== "outline" && query.mode !== "paragraphs" && query.mode !== "search")) {
    throw new TypeError("Office 文档检查查询无效");
  }
  if (
    query.parts !== undefined &&
    (!Array.isArray(query.parts) ||
      query.parts.length < 1 ||
      new Set(query.parts).size !== query.parts.length ||
      query.parts.some((part) => part !== "document" && part !== "header" && part !== "footer" && part !== "comments"))
  ) {
    throw new TypeError("Office 文档检查部件无效");
  }
  if (query.mode === "paragraphs") {
    if (!Array.isArray(query.paragraphIds) || query.paragraphIds.length < 1) {
      throw new TypeError("Office 文档检查段落 ID 无效");
    }
    return Math.min(query.paragraphIds.length, MAX_INSPECTION_PARAGRAPHS);
  }
  if (query.mode === "search" && (typeof query.text !== "string" || !query.text.trim() || query.text.length > 128)) {
    throw new TypeError("Office 文档搜索文本无效");
  }
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Office 文档检查数量无效");
  return Math.min(limit, MAX_INSPECTION_PARAGRAPHS);
}

function selectInspectionParagraphs(
  snapshot: DocxInspectSnapshot,
  query: DocxInspectionQuery,
  limit: number,
): { paragraphs: InspectionParagraph[]; truncated: boolean } {
  const requestedParts = new Set(query.parts ?? ["document", "header", "footer"]);
  let candidates: InspectionParagraph[] = [
    ...snapshot.paragraphs.map((paragraph) => ({ paragraph, part: "document" as const })),
    ...snapshot.relatedParts.flatMap((part) =>
      part.paragraphs.map((paragraph) => ({ paragraph, part: part.kind, relatedPartId: part.id })),
    ),
    ...snapshot.comments.flatMap((comment) =>
      comment.paragraphs.map((paragraph) => ({
        paragraph,
        part: "comments" as const,
        commentId: comment.id,
        commentAuthor: comment.author,
      })),
    ),
  ].filter((candidate) => requestedParts.has(candidate.part));
  if (query.mode === "paragraphs") {
    const requested = new Set(query.paragraphIds.slice(0, MAX_INSPECTION_PARAGRAPHS));
    candidates = candidates.filter(({ paragraph }) => requested.has(paragraph.id));
    if (candidates.length !== requested.size) throw new Error("Office 文档段落不存在");
  } else if (query.mode === "search") {
    const needle = query.text.toLocaleLowerCase();
    candidates = candidates.filter(({ paragraph }) => paragraphText(paragraph).toLocaleLowerCase().includes(needle));
  }
  return { paragraphs: candidates.slice(0, limit), truncated: candidates.length > limit };
}

function inspectionBase(document: OpenDocument, truncated: boolean) {
  return {
    documentId: document.snapshot.documentId,
    path: document.path,
    revision: document.snapshot.revision,
    warnings: document.snapshot.warnings.map((warning) => ({ ...warning })),
    truncated,
  };
}

function paragraphText(paragraph: DocxParagraphSnapshot | RelatedPartParagraphSnapshot): string {
  return paragraph.runs.map((run) => run.text).join("");
}

function publicPlan(plan: DocumentPlan): Omit<OfficeDocumentPlan, "planId"> {
  return {
    documentId: plan.documentId,
    baseRevision: plan.baseRevision,
    resultingRevision: plan.resultingRevision,
    semanticDiff: plan.semanticDiff.map((diff) =>
      "type" in diff ? { ...diff } : { type: "run-text" as const, ...diff },
    ),
    touchedRuns: [...plan.touchedRuns],
    touchedParagraphs: [...plan.touchedParagraphs],
    touchedParts: [...plan.touchedParts],
    warnings: plan.warnings.map((warning) => ({ ...warning })),
    expiresAt: plan.expiresAt,
    planSha256: plan.planSha256,
  };
}

function toPreview(document: OpenDocument): DocxDocumentPreview {
  return {
    kind: "docx",
    format: "docx",
    path: document.path,
    renderTree: {
      documentId: document.snapshot.documentId,
      revision: document.snapshot.revision,
      format: "docx",
      root: {
        type: "document",
        children: document.snapshot.paragraphs.map((paragraph) => toParagraph(paragraph, "document")),
        relatedParts: document.snapshot.relatedParts.map((part) => ({
          id: part.id,
          kind: part.kind,
          blocked: part.blocked,
          paragraphs: part.paragraphs.map((paragraph) => toParagraph(paragraph, part.kind, { relatedPartId: part.id })),
        })),
        comments: document.snapshot.comments.map((comment) => ({
          id: comment.id,
          author: comment.author,
          ...(comment.date ? { date: comment.date } : {}),
          ...(comment.initials ? { initials: comment.initials } : {}),
          blocked: comment.blocked,
          paragraphs: comment.paragraphs.map((paragraph) =>
            toParagraph(paragraph, "comments", { commentId: comment.id, commentAuthor: comment.author }),
          ),
        })),
      },
      warnings: [
        {
          code: "continuous-layout",
          part: document.snapshot.mainPart,
          message: "当前为连续流视图，分页可能与 Microsoft Word 不同",
        },
        ...document.snapshot.warnings.map((warning) => ({ ...warning })),
      ],
    },
  };
}

function toParagraph(
  paragraph: DocxParagraphSnapshot | RelatedPartParagraphSnapshot,
  part: OfficeDocumentPartKind,
  metadata: { readonly relatedPartId?: string; readonly commentId?: string; readonly commentAuthor?: string } = {},
): OfficeDocumentParagraph {
  const text = paragraphText(paragraph);
  return {
    type: "paragraph",
    id: paragraph.id,
    part,
    ...(metadata.relatedPartId ? { relatedPartId: metadata.relatedPartId } : {}),
    ...(metadata.commentId ? { commentId: metadata.commentId } : {}),
    ...(metadata.commentAuthor ? { commentAuthor: metadata.commentAuthor } : {}),
    editable: paragraph.editable,
    ...(paragraph.blockedReason ? { blockedReason: paragraph.blockedReason } : {}),
    textSha256: "anchor" in paragraph ? paragraph.anchor.textHash : sha256Hex(new TextEncoder().encode(text)),
    runs: paragraph.runs.map((run) => ({
      type: "text-run",
      id: run.id,
      text: run.text,
      properties: "properties" in run ? { ...run.properties } : {},
      editable: run.editable,
      ...(run.blockedReason ? { blockedReason: run.blockedReason } : {}),
      textSha256: run.anchor.textHash,
    })),
  };
}
