import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeOfficeDocumentService } from "../src/main/files/native-office-document-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];
const source = join(import.meta.dirname, "../../office-engine/test/corpus-xlsx/simple-normal.xlsx");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native XLSX document service", () => {
  it("enforces inspection, owner, audit, one-shot plan, and idle lifecycle boundaries", async () => {
    const fixture = await createFixture();
    let clock = 100;
    const auditRows: Array<{ status: string; approvedAt?: number }> = [];
    const service = new NativeOfficeDocumentService(fixture.store, {
      now: () => clock++,
      idleTimeoutMs: 1_000,
      idleSweepIntervalMs: 60_000,
      onAudit: (audit) => auditRows.push({ status: audit.status, approvedAt: audit.approvedAt }),
    });
    const opened = await service.open(51, fixture.projectId, "reports/budget.xlsx");
    if (opened.kind !== "xlsx") throw new Error("expected xlsx preview");
    await expect(
      service.inspectForAgent(fixture.projectId, opened.documentId, {
        mode: "cells",
        sheetId: opened.sheets[0]!.id,
        limit: -1,
      }),
    ).rejects.toThrow("limit");
    const cell = opened.sheets[0]?.cells.find((item) => item.address === "A1");
    if (!cell) throw new Error("fixture cell missing");
    const plan = await service.plan(51, {
      documentId: opened.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "set_cell_value",
            target: { sheetId: opened.sheets[0]!.id, cellId: cell.id, address: cell.address },
            precondition: {
              documentRevision: opened.revision,
              expectedValue: cell.value,
              expectedValueSha256: cell.valueSha256,
            },
            replacement: "lifecycle checked",
          },
        ],
      },
    });
    await expect(
      service.commit(52, { documentId: opened.documentId, planId: plan.planId, planSha256: plan.planSha256 }),
    ).rejects.toThrow("不存在");
    await service.commit(51, { documentId: opened.documentId, planId: plan.planId, planSha256: plan.planSha256 });
    await expect(
      service.commit(51, { documentId: opened.documentId, planId: plan.planId, planSha256: plan.planSha256 }),
    ).rejects.toThrow("不存在");
    const approved = auditRows.find((audit) => audit.status === "approved");
    const committed = auditRows.find((audit) => audit.status === "committed");
    expect(approved?.approvedAt).toBeTypeOf("number");
    expect(committed?.approvedAt).toBe(approved?.approvedAt);
    service.dispose();

    let now = 10;
    const idle = new NativeOfficeDocumentService(fixture.store, {
      now: () => now,
      idleTimeoutMs: 5,
      idleSweepIntervalMs: 60_000,
      onAudit: () => {
        throw new Error("audit unavailable");
      },
    });
    const idleOpened = await idle.open(53, fixture.projectId, "reports/budget.xlsx");
    if (idleOpened.kind !== "xlsx") throw new Error("expected xlsx preview");
    const idleCell = idleOpened.sheets[0]?.cells.find((item) => item.address === "A1");
    if (!idleCell) throw new Error("fixture cell missing");
    const auditFailurePlan = await idle.plan(53, {
      documentId: idleOpened.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "set_cell_value",
            target: { sheetId: idleOpened.sheets[0]!.id, cellId: idleCell.id, address: idleCell.address },
            precondition: {
              documentRevision: idleOpened.revision,
              expectedValue: idleCell.value,
              expectedValueSha256: idleCell.valueSha256,
            },
            replacement: "audit failure isolated",
          },
        ],
      },
    });
    await expect(
      idle.commit(53, {
        documentId: idleOpened.documentId,
        planId: auditFailurePlan.planId,
        planSha256: auditFailurePlan.planSha256,
      }),
    ).resolves.toMatchObject({ preview: { kind: "xlsx" } });
    now = 16;
    await expect(
      idle.inspectForAgent(fixture.projectId, idleOpened.documentId, {
        mode: "cells",
        sheetId: idleOpened.sheets[0]!.id,
      }),
    ).rejects.toThrow("不存在");
    idle.dispose();
  });

  it("rejects expired and forged plans and preserves external writes", async () => {
    const fixture = await createFixture();
    let now = 1_000;
    const service = new NativeOfficeDocumentService(fixture.store, { now: () => now });
    const opened = await service.open(61, fixture.projectId, "reports/budget.xlsx");
    if (opened.kind !== "xlsx") throw new Error("expected xlsx preview");
    const cell = opened.sheets[0]?.cells.find((item) => item.address === "A1");
    const sheet = opened.sheets[0];
    if (!cell || !sheet) throw new Error("fixture cell missing");
    const createPlan = () =>
      service.plan(61, {
        documentId: opened.documentId,
        envelope: {
          protocolVersion: 1,
          operations: [
            {
              type: "set_cell_value",
              target: { sheetId: sheet.id, cellId: cell.id, address: cell.address },
              precondition: {
                documentRevision: opened.revision,
                expectedValue: cell.value,
                expectedValueSha256: cell.valueSha256,
              },
              replacement: "must not be committed",
            },
          ],
        },
      });
    const original = await readFile(fixture.path);

    const expired = await createPlan();
    now = expired.expiresAt;
    await expect(
      service.commit(61, {
        documentId: opened.documentId,
        planId: expired.planId,
        planSha256: expired.planSha256,
      }),
    ).rejects.toThrow("TRANSACTION_EXPIRED");
    expect(await readFile(fixture.path)).toEqual(original);

    now = 2_000;
    const forged = await createPlan();
    await expect(
      service.commit(61, {
        documentId: opened.documentId,
        planId: forged.planId,
        planSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("校验失败");
    expect(await readFile(fixture.path)).toEqual(original);

    const stale = await createPlan();
    const external = new TextEncoder().encode("external workbook replacement");
    await writeFile(fixture.path, external);
    await expect(
      service.commit(61, {
        documentId: opened.documentId,
        planId: stale.planId,
        planSha256: stale.planSha256,
      }),
    ).rejects.toThrow("STALE_DOCUMENT");
    expect(await readFile(fixture.path)).toEqual(Buffer.from(external));
    service.dispose();
  });

  it("rejects inspection after an equal-size external rewrite with restored mtime", async () => {
    const fixture = await createFixture();
    const service = new NativeOfficeDocumentService(fixture.store);
    const opened = await service.open(71, fixture.projectId, "reports/budget.xlsx");
    if (opened.kind !== "xlsx") throw new Error("expected xlsx preview");
    const beforeInfo = await stat(fixture.path);
    const external = new Uint8Array(await readFile(fixture.path));
    external[external.length - 1] = (external[external.length - 1] ?? 0) ^ 1;
    await writeFile(fixture.path, external);
    await utimes(fixture.path, beforeInfo.atime, beforeInfo.mtime);

    await expect(service.inspectForAgent(fixture.projectId, opened.documentId, { mode: "sheets" })).rejects.toThrow(
      "STALE_DOCUMENT",
    );
    expect(await readFile(fixture.path)).toEqual(Buffer.from(external));
    service.dispose();
  });

  it("Agent XLSX 规划等待磁盘检查时关闭 Project 不会留下孤儿计划", async () => {
    const fixture = await createFixture();
    const service = new NativeOfficeDocumentService(fixture.store);
    const opened = await service.open(72, fixture.projectId, "reports/budget.xlsx");
    if (opened.kind !== "xlsx") throw new Error("expected xlsx preview");
    const sheet = opened.sheets[0];
    const cell = sheet?.cells.find((item) => item.address === "A1");
    if (!sheet || !cell) throw new Error("fixture cell missing");

    const pending = service.planForAgent(fixture.projectId, {
      documentId: opened.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "set_cell_value",
            target: { sheetId: sheet.id, cellId: cell.id, address: cell.address },
            precondition: {
              documentRevision: opened.revision,
              expectedValue: cell.value,
              expectedValueSha256: cell.valueSha256,
            },
            replacement: "must be rejected",
          },
        ],
      },
    });
    service.closeProject(fixture.projectId);

    await expect(pending).rejects.toThrow("XLSX 文档窗口已关闭");
    expect(service.listForAgent(fixture.projectId)).toEqual([]);
    service.dispose();
  });

  it("opens, inspects, plans, commits, and reopens an admitted workbook", async () => {
    const fixture = await createFixture();
    const created = vi.fn();
    const audits = vi.fn();
    const service = new NativeOfficeDocumentService(fixture.store, { onPlanCreated: created, onAudit: audits });
    const opened = await service.open(41, fixture.projectId, "reports/budget.xlsx");
    if (opened.kind !== "xlsx") throw new Error("expected xlsx preview");
    expect(opened.sheets.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "sheet:rId1", name: "Sheet1" },
      { id: "sheet:rId2", name: "Sheet Number 2" },
    ]);
    const cell = opened.sheets[0]?.cells.find((item) => item.address === "A1");
    if (!cell) throw new Error("fixture cell missing");
    expect(cell).toMatchObject({ id: "rId1:A1", value: "test", editable: true });

    const inspected = await service.inspectForAgent(fixture.projectId, opened.documentId, {
      mode: "cells",
      sheetId: "sheet:rId1",
      range: "A1:C2",
    });
    expect(inspected.mode).toBe("cells");
    if (inspected.mode !== "cells") throw new Error("expected cell inspection");
    expect(inspected.cells.map((item) => item.address)).toEqual(["A1", "C1", "A2", "C2"]);

    const plan = await service.planForAgent(fixture.projectId, {
      documentId: opened.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "set_cell_value",
            target: { sheetId: "sheet:rId1", cellId: cell.id, address: cell.address },
            precondition: {
              documentRevision: opened.revision,
              expectedValue: cell.value,
              expectedValueSha256: cell.valueSha256,
            },
            replacement: "Approved budget",
          },
        ],
      },
    });
    expect(plan).toMatchObject({
      touchedCells: [cell.id],
      touchedParts: ["xl/worksheets/sheet1.xml"],
      semanticDiff: [{ type: "cell-value", address: "A1", after: "Approved budget" }],
    });
    expect(created).toHaveBeenCalledWith(41, plan);

    const result = await service.commit(41, {
      documentId: opened.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(result.preview.kind).toBe("xlsx");
    if (result.preview.kind !== "xlsx") throw new Error("expected xlsx commit result");
    expect(result.preview.revision).toBe(2);
    expect(result.preview.sheets[0]?.cells.find((item) => item.address === "A1")?.value).toBe("Approved budget");
    expect(audits).toHaveBeenCalled();

    const reopened = await new NativeOfficeDocumentService(fixture.store).open(
      42,
      fixture.projectId,
      "reports/budget.xlsx",
    );
    expect(reopened.kind === "xlsx" && reopened.sheets[0]?.cells.find((item) => item.address === "A1")?.value).toBe(
      "Approved budget",
    );
    expect(await readFile(fixture.path)).not.toHaveLength(0);
    service.dispose();
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-xlsx-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const path = join(cwd, "reports", "budget.xlsx");
  await mkdir(join(cwd, "reports"), { recursive: true });
  await copyFile(source, path);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { store, projectId: project.id, path };
}
