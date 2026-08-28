import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import {
  commitXlsx,
  inspectXlsx,
  PackageArchive,
  planXlsx,
  sha256Hex,
  type XlsxInspectSnapshot,
  type XlsxPlan,
} from "@earendil-works/pi-office-engine";
import type {
  CommitOfficeDocumentInput,
  CommitOfficeDocumentResult,
  DiscardOfficeDocumentPlanInput,
  OfficeDocumentHandle,
  OfficeDocumentInspection,
  OfficeDocumentInspectionQuery,
  OfficeDocumentPlan,
  PlanOfficeDocumentInput,
  XlsxCell,
  XlsxDocumentPreview,
} from "../../shared/office-document-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { replaceFileAtomically } from "./atomic-file-replacement.ts";
import type { OfficeDocumentServiceOptions, OfficeDocumentTransactionAudit } from "./office-document-service.ts";
import { officeTransactionAuditErrorCode } from "./office-transaction-audit.ts";
import { normalizeProjectRelativePath, resolveProjectFilePath } from "./project-file-path.ts";

const MAX_XLSX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OPEN_DOCUMENTS = 64;
const DEFAULT_MAX_OPEN_DOCUMENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_DOCUMENT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
const MAX_INSPECTION_CELLS = 500;
const MAX_PREVIEW_CELLS = 500;
const MAX_PREVIEW_ROWS = 10_000;
const MAX_PREVIEW_COLUMNS = 26;
const PLAN_TTL_MS = 5 * 60_000;

interface OpenSpreadsheet {
  ownerId: number;
  projectId: string;
  path: string;
  absolutePath: string;
  archive: PackageArchive;
  snapshot: XlsxInspectSnapshot;
  fingerprint: { size: number; mtimeMs: number; sha256: string };
  byteSize: number;
  lastAccessedAt: number;
}

interface PendingSpreadsheetPlan {
  ownerId: number;
  documentId: string;
  createdAt: number;
  approvedAt?: number;
  snapshot: XlsxInspectSnapshot;
  plan: XlsxPlan;
}

export type XlsxDocumentServiceOptions = OfficeDocumentServiceOptions;

export class XlsxDocumentService {
  private readonly documents = new Map<string, OpenSpreadsheet>();
  private readonly plans = new Map<string, PendingSpreadsheetPlan>();
  private readonly projects: ProjectStore;
  private readonly options: XlsxDocumentServiceOptions;
  private readonly now: () => number;
  private readonly maxOpenDocuments: number;
  private readonly maxOpenDocumentBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly idleSweepTimer: ReturnType<typeof setInterval>;
  private readonly committingPaths = new Set<string>();
  private readonly ownerGenerations = new Map<number, number>();
  private readonly currentChecks = new Map<string, Promise<void>>();

  constructor(projects: ProjectStore, options: XlsxDocumentServiceOptions = {}) {
    this.projects = projects;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.maxOpenDocuments = positiveInteger(options.maxOpenDocuments, DEFAULT_MAX_OPEN_DOCUMENTS);
    this.maxOpenDocumentBytes = positiveInteger(options.maxOpenDocumentBytes, DEFAULT_MAX_OPEN_DOCUMENT_BYTES);
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_DOCUMENT_IDLE_TIMEOUT_MS);
    const sweepIntervalMs = positiveInteger(options.idleSweepIntervalMs, DEFAULT_IDLE_SWEEP_INTERVAL_MS);
    this.idleSweepTimer = setInterval(() => this.collectIdleDocuments(), sweepIntervalMs);
    this.idleSweepTimer.unref?.();
  }

  async open(ownerId: number, projectId: string, path: string): Promise<XlsxDocumentPreview> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !projectId || typeof path !== "string")
      throw new TypeError("XLSX 打开参数无效");
    const ownerGeneration = this.ownerGeneration(ownerId);
    const cwd = await realpath(this.projects.getCwd(projectId));
    const absolutePath = await realpath(resolveProjectFilePath(cwd, path));
    resolveProjectFilePath(cwd, absolutePath);
    if (extname(absolutePath).toLowerCase() !== ".xlsx") throw new Error("不是 XLSX 文档");
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_XLSX_BYTES) throw new Error("XLSX 文档无效或超过 50 MiB 限制");
    const bytes = await readFile(absolutePath);
    if (bytes.byteLength > MAX_XLSX_BYTES) throw new Error("XLSX 文档无效或超过 50 MiB 限制");
    const archive = PackageArchive.open(bytes);
    const documentId = randomUUID();
    const snapshot = inspectXlsx(archive, documentId);
    const normalizedPath = normalizeProjectRelativePath(relative(cwd, absolutePath));
    this.assertOwnerGeneration(ownerId, ownerGeneration);
    for (const [id, item] of this.documents)
      if (item.ownerId === ownerId && item.projectId === projectId && item.path === normalizedPath) this.remove(id);
    this.ensureCapacity(bytes.byteLength);
    const openedAt = this.now();
    this.documents.set(documentId, {
      ownerId,
      projectId,
      path: normalizedPath,
      absolutePath,
      archive,
      snapshot,
      fingerprint: { size: info.size, mtimeMs: info.mtimeMs, sha256: snapshot.sourceSha256 },
      byteSize: bytes.byteLength,
      lastAccessedAt: openedAt,
    });
    return preview(this.documents.get(documentId)!);
  }

  async inspect(
    ownerId: number,
    documentId: string,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    return this.inspectDocument(this.ownerDocument(ownerId, documentId), query);
  }

  listForAgent(projectId: string): OfficeDocumentHandle[] {
    this.collectIdleDocuments();
    this.projects.getCwd(projectId);
    return [...this.documents.values()]
      .filter((document) => document.projectId === projectId)
      .map((document) => ({
        documentId: document.snapshot.documentId,
        path: document.path,
        format: "xlsx" as const,
        revision: document.snapshot.revision,
      }));
  }

  async inspectForAgent(
    projectId: string,
    documentId: string,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    return this.inspectDocument(this.projectDocument(projectId, documentId), query);
  }

  private async inspectDocument(
    document: OpenSpreadsheet,
    query: OfficeDocumentInspectionQuery,
  ): Promise<OfficeDocumentInspection> {
    await this.assertCurrentForInspection(document);
    if (query.mode !== "sheets" && query.mode !== "cells" && query.mode !== "search-cells")
      throw new Error("XLSX inspection mode 无效");
    if (
      (query.mode === "cells" &&
        (typeof query.sheetId !== "string" || !document.snapshot.sheets.some((sheet) => sheet.id === query.sheetId))) ||
      (query.mode === "search-cells" &&
        (typeof query.text !== "string" || !query.text.trim() || query.text.length > 128))
    )
      throw new TypeError("XLSX inspection query 无效");
    const requestedLimit = query.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new TypeError("XLSX inspection limit 无效");
    const limit = Math.min(requestedLimit, MAX_INSPECTION_CELLS);
    const sheets = document.snapshot.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      cellCount: sheet.cells.length,
    }));
    let cells =
      query.mode === "sheets"
        ? []
        : document.snapshot.sheets
            .filter((sheet) =>
              query.mode === "search-cells" ? !query.sheetId || sheet.id === query.sheetId : sheet.id === query.sheetId,
            )
            .flatMap((sheet) => sheet.cells);
    const range = query.mode === "cells" && query.range ? parseRange(query.range) : undefined;
    if (range) cells = cells.filter((cell) => inRange(cell.address, range));
    if (query.mode === "search-cells") {
      const needle = query.text.toLocaleLowerCase();
      cells = cells.filter((cell) => cell.value.toLocaleLowerCase().includes(needle));
    }
    const selected = cells.slice(0, limit);
    return {
      mode: query.mode,
      documentId: document.snapshot.documentId,
      path: document.path,
      revision: document.snapshot.revision,
      warnings: [],
      truncated: cells.length > selected.length,
      sheets,
      cells: selected.map(publicCell),
    };
  }

  async plan(ownerId: number, input: PlanOfficeDocumentInput): Promise<OfficeDocumentPlan> {
    const ownerGeneration = this.ownerGeneration(ownerId);
    const document = this.ownerDocument(ownerId, input.documentId);
    const result = await this.createPlan(document, input);
    try {
      this.assertOwnerGeneration(ownerId, ownerGeneration);
      if (this.documents.get(input.documentId) !== document) throw new Error("XLSX 文档窗口已关闭");
    } catch (error) {
      this.plans.delete(result.planId);
      throw error;
    }
    return result;
  }

  async planForAgent(projectId: string, input: PlanOfficeDocumentInput): Promise<OfficeDocumentPlan> {
    const document = this.projectDocument(projectId, input.documentId);
    const ownerGeneration = this.ownerGeneration(document.ownerId);
    const result = await this.createPlan(document, input);
    try {
      this.assertOwnerGeneration(document.ownerId, ownerGeneration);
      if (this.documents.get(input.documentId) !== document) throw new Error("XLSX 文档窗口已关闭");
    } catch (error) {
      this.plans.delete(result.planId);
      throw error;
    }
    this.options.onPlanCreated?.(document.ownerId, result);
    return result;
  }

  discard(ownerId: number, input: DiscardOfficeDocumentPlanInput): void {
    const pending = this.plans.get(input.planId);
    if (!pending || pending.ownerId !== ownerId || pending.documentId !== input.documentId)
      throw new Error("XLSX 修改计划不存在");
    const document = this.ownerDocument(ownerId, input.documentId);
    this.plans.delete(input.planId);
    this.writeAudit(document, pending, "rejected");
  }

  async commit(ownerId: number, input: CommitOfficeDocumentInput): Promise<CommitOfficeDocumentResult> {
    const pending = this.plans.get(input.planId);
    if (!pending || pending.ownerId !== ownerId || pending.documentId !== input.documentId)
      throw new Error("XLSX 修改计划不存在");
    const document = this.ownerDocument(ownerId, input.documentId);
    this.projects.getCwd(document.projectId);
    this.plans.delete(input.planId);
    let ownsCommitLock = false;
    let approved = false;
    try {
      if (pending.plan.planSha256 !== input.planSha256) throw new Error("XLSX 修改计划校验失败");
      approved = true;
      pending.approvedAt = this.now();
      this.writeAudit(document, pending, "approved", true);
      if (this.committingPaths.has(document.absolutePath)) throw new Error("XLSX 文档正在保存");
      this.committingPaths.add(document.absolutePath);
      ownsCommitLock = true;
      await this.assertCurrent(document);
      const bytes = commitXlsx(document.archive, pending.snapshot, pending.plan, this.now());
      this.ensureCapacity(bytes.byteLength, document.snapshot.documentId);
      await replaceFileAtomically(document.absolutePath, pending.plan.sourceSha256, bytes);
      const info = await stat(document.absolutePath);
      document.archive = PackageArchive.open(bytes);
      document.snapshot = inspectXlsx(document.archive, document.snapshot.documentId, pending.plan.resultingRevision);
      document.fingerprint = { size: info.size, mtimeMs: info.mtimeMs, sha256: document.snapshot.sourceSha256 };
      document.byteSize = bytes.byteLength;
      document.lastAccessedAt = this.now();
      this.deleteDocumentPlans(document.snapshot.documentId);
      this.writeAudit(document, pending, "committed", true);
      return { preview: preview(document), planSha256: pending.plan.planSha256 };
    } catch (error) {
      this.writeAudit(
        document,
        pending,
        error instanceof Error && error.message === "STALE_DOCUMENT" ? "stale" : "failed",
        approved,
        officeTransactionAuditErrorCode(error),
      );
      throw error;
    } finally {
      if (ownsCommitLock) this.committingPaths.delete(document.absolutePath);
    }
  }

  has(documentId: string): boolean {
    this.collectIdleDocuments();
    return this.documents.has(documentId);
  }
  closeOwner(ownerId: number): void {
    this.ownerGenerations.set(ownerId, this.ownerGeneration(ownerId) + 1);
    for (const [id, item] of this.documents) if (item.ownerId === ownerId) this.remove(id);
  }
  closeProject(projectId: string): void {
    for (const [id, item] of this.documents) if (item.projectId === projectId) this.remove(id);
  }
  dispose(): void {
    clearInterval(this.idleSweepTimer);
    this.documents.clear();
    this.plans.clear();
    this.committingPaths.clear();
    this.currentChecks.clear();
  }

  private async createPlan(document: OpenSpreadsheet, input: PlanOfficeDocumentInput): Promise<OfficeDocumentPlan> {
    await this.assertCurrent(document);
    const plan = planXlsx(document.archive, document.snapshot, input.envelope, this.now() + PLAN_TTL_MS, this.now());
    this.deleteDocumentPlans(document.snapshot.documentId);
    const pending = {
      ownerId: document.ownerId,
      documentId: document.snapshot.documentId,
      createdAt: this.now(),
      snapshot: document.snapshot,
      plan,
    };
    this.plans.set(plan.planId, pending);
    const result = publicPlan(plan);
    this.writeAudit(document, pending, "planned");
    return result;
  }

  private ownerDocument(ownerId: number, documentId: string): OpenSpreadsheet {
    this.collectIdleDocuments();
    const document = this.documents.get(documentId);
    if (!document || document.ownerId !== ownerId) throw new Error("XLSX 文档未打开");
    document.lastAccessedAt = this.now();
    return document;
  }
  private projectDocument(projectId: string, documentId: string): OpenSpreadsheet {
    this.collectIdleDocuments();
    const document = this.documents.get(documentId);
    if (!document || document.projectId !== projectId) throw new Error("XLSX 文档未打开");
    this.projects.getCwd(projectId);
    document.lastAccessedAt = this.now();
    return document;
  }
  private async assertCurrentForInspection(document: OpenSpreadsheet): Promise<void> {
    const documentId = document.snapshot.documentId;
    const existing = this.currentChecks.get(documentId);
    if (existing) return existing;
    let check: Promise<void>;
    check = this.assertCurrent(document).finally(() => {
      if (this.currentChecks.get(documentId) === check) this.currentChecks.delete(documentId);
    });
    this.currentChecks.set(documentId, check);
    return check;
  }
  private async assertCurrent(document: OpenSpreadsheet): Promise<void> {
    const info = await stat(document.absolutePath);
    const bytes = await readFile(document.absolutePath);
    const currentSha256 = sha256Hex(bytes);
    if (currentSha256 !== document.fingerprint.sha256 || info.size !== bytes.byteLength)
      throw new Error("STALE_DOCUMENT");
    document.fingerprint = { size: info.size, mtimeMs: info.mtimeMs, sha256: currentSha256 };
  }
  private remove(documentId: string): void {
    this.documents.delete(documentId);
    this.deleteDocumentPlans(documentId);
  }
  private deleteDocumentPlans(documentId: string): void {
    for (const [planId, plan] of this.plans) if (plan.documentId === documentId) this.plans.delete(planId);
  }
  private collectIdleDocuments(): void {
    const expiredBefore = this.now() - this.idleTimeoutMs;
    for (const [documentId, document] of this.documents)
      if (document.lastAccessedAt <= expiredBefore && !this.committingPaths.has(document.absolutePath))
        this.remove(documentId);
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
      if (!candidate) throw new Error("XLSX 文档缓存容量不足");
      this.remove(candidate[0]);
    }
  }
  private openDocumentBytes(): number {
    let total = 0;
    for (const document of this.documents.values()) total += document.byteSize;
    return total;
  }
  private ownerGeneration(ownerId: number): number {
    return this.ownerGenerations.get(ownerId) ?? 0;
  }
  private assertOwnerGeneration(ownerId: number, expected: number): void {
    if (this.ownerGeneration(ownerId) !== expected) throw new Error("XLSX 文档窗口已关闭");
  }
  private writeAudit(
    document: OpenSpreadsheet,
    pending: PendingSpreadsheetPlan,
    status: OfficeDocumentTransactionAudit["status"],
    approved = false,
    errorCode?: string,
  ): void {
    const now = this.now();
    const completed = status === "rejected" || status === "committed" || status === "stale" || status === "failed";
    try {
      this.options.onAudit?.({
        transactionId: pending.plan.planId,
        projectId: document.projectId,
        relativePath: document.path,
        format: "xlsx",
        sourceSha256: pending.plan.sourceSha256,
        ...(status === "committed" ? { outputSha256: document.snapshot.sourceSha256 } : {}),
        operationTypes: pending.plan.operations.map((operation) => operation.type),
        operationCount: pending.plan.operations.length,
        touchedParts: [...pending.plan.touchedParts],
        planSha256: pending.plan.planSha256,
        ...(approved ? { approvedAt: pending.approvedAt ?? now, approvalChannel: "renderer_user" as const } : {}),
        status,
        createdAt: pending.createdAt,
        ...(completed ? { completedAt: now } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // 审计输出失败不能改变已经确定的事务结果。
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("XLSX 文档服务资源限制无效");
  return value;
}
function preview(document: OpenSpreadsheet): XlsxDocumentPreview {
  return {
    kind: "xlsx",
    format: "xlsx",
    path: document.path,
    documentId: document.snapshot.documentId,
    revision: document.snapshot.revision,
    sheets: document.snapshot.sheets.map((sheet, index) => {
      const dimensions = sheetDimensions(sheet.cells);
      const visible = sheet.cells.filter((cell) => {
        const point = coordinate(cell.address);
        return point.row <= MAX_PREVIEW_ROWS && point.column <= MAX_PREVIEW_COLUMNS;
      });
      const cells = index === 0 ? visible.slice(0, MAX_PREVIEW_CELLS).map(publicCell) : [];
      return {
        id: sheet.id,
        name: sheet.name,
        rowCount: Math.min(dimensions.rows, MAX_PREVIEW_ROWS),
        columnCount: Math.min(dimensions.columns, MAX_PREVIEW_COLUMNS),
        cellCount: sheet.cells.length,
        truncated:
          dimensions.rows > MAX_PREVIEW_ROWS ||
          dimensions.columns > MAX_PREVIEW_COLUMNS ||
          cells.length < visible.length,
        cells,
      };
    }),
  };
}
function publicCell(cell: XlsxInspectSnapshot["sheets"][number]["cells"][number]): XlsxCell {
  return {
    id: cell.id,
    address: cell.address,
    value: cell.value,
    valueSha256: cell.valueSha256,
    valueType: cell.valueType,
    editable: cell.editable,
    ...(cell.blockedReason ? { blockedReason: cell.blockedReason } : {}),
    ...(cell.styleId ? { styleId: cell.styleId } : {}),
  };
}
function publicPlan(plan: XlsxPlan): OfficeDocumentPlan {
  return {
    planId: plan.planId,
    documentId: plan.documentId,
    baseRevision: plan.baseRevision,
    resultingRevision: plan.resultingRevision,
    semanticDiff: [...plan.semanticDiff],
    touchedRuns: [],
    touchedParagraphs: [],
    touchedCells: [...plan.touchedCells],
    touchedParts: [...plan.touchedParts],
    warnings: [],
    expiresAt: plan.expiresAt,
    planSha256: plan.planSha256,
  };
}
interface CellRange {
  readonly start: { readonly column: number; readonly row: number };
  readonly end: { readonly column: number; readonly row: number };
}
function parseRange(range: string): CellRange {
  const match = /^([A-Z]{1,3}[1-9][0-9]{0,6}):([A-Z]{1,3}[1-9][0-9]{0,6})$/iu.exec(range.trim());
  if (!match) throw new Error("XLSX range 必须是 A1:B10");
  return { start: coordinate(match[1]!), end: coordinate(match[2]!) };
}
function inRange(address: string, range: CellRange): boolean {
  const cell = coordinate(address);
  return (
    cell.column >= Math.min(range.start.column, range.end.column) &&
    cell.column <= Math.max(range.start.column, range.end.column) &&
    cell.row >= Math.min(range.start.row, range.end.row) &&
    cell.row <= Math.max(range.start.row, range.end.row)
  );
}
function sheetDimensions(cells: readonly XlsxInspectSnapshot["sheets"][number]["cells"][number][]): {
  rows: number;
  columns: number;
} {
  let rows = 1;
  let columns = 1;
  for (const cell of cells) {
    const point = coordinate(cell.address);
    rows = Math.max(rows, point.row);
    columns = Math.max(columns, point.column);
  }
  return { rows, columns };
}
function coordinate(address: string): { column: number; row: number } {
  const match = /^([A-Z]+)([0-9]+)$/u.exec(address.toUpperCase());
  if (!match) throw new Error("XLSX cell address 无效");
  let column = 0;
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}
