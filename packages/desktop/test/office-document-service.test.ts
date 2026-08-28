import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageArchive, sha256Hex } from "@earendil-works/pi-office-engine";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeDocumentService } from "../src/main/files/office-document-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];
const fixturePath = join(import.meta.dirname, "../../office-engine/test/corpus/strict-format.docx");
const commentsFixturePath = join(import.meta.dirname, "../../office-engine/test/corpus/comments.docx");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OfficeDocumentService", () => {
  it("打开、计划、提交并重新打开真实 DOCX", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(7, fixture.projectId, "reports/document.docx");
    const run = preview.renderTree.root.children[0]?.runs[0];
    if (!run) throw new Error("测试 DOCX 缺少文本运行");

    expect(preview).toMatchObject({
      kind: "docx",
      format: "docx",
      path: "reports/document.docx",
      renderTree: { format: "docx", revision: 1, root: { type: "document" } },
    });
    expect(run).toMatchObject({ text: "Test", editable: true });

    const plan = await service.plan(7, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "replace_text_run",
            target: { part: "document", paragraphId: preview.renderTree.root.children[0].id, runId: run.id },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: run.text,
              expectedTextSha256: run.textSha256,
            },
            replacement: "Changed & verified",
          },
        ],
      },
    });

    expect(plan).toMatchObject({
      documentId: preview.renderTree.documentId,
      baseRevision: 1,
      resultingRevision: 2,
      touchedRuns: [run.id],
      touchedParts: ["word/document.xml"],
      semanticDiff: [{ runId: run.id, before: "Test", after: "Changed & verified" }],
    });
    expect(plan).not.toHaveProperty("patches");

    const committed = await service.commit(7, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(committed.preview.renderTree.revision).toBe(2);
    expect(committed.preview.renderTree.root.children[0]?.runs[0]?.text).toBe("Changed & verified");

    const reopened = await new OfficeDocumentService(fixture.store).open(8, fixture.projectId, "reports/document.docx");
    expect(reopened.renderTree.root.children[0]?.runs[0]?.text).toBe("Changed & verified");
  });

  it("为所属 renderer 提供编辑源并直接保存完整 DOCX", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(7, fixture.projectId, "reports/document.docx");
    const source = await service.getEditorSource(7, preview.renderTree.documentId);
    expect(source).toMatchObject({
      documentId: preview.renderTree.documentId,
      revision: 1,
      sourceSha256: expect.any(String),
    });
    expect(source.bytes).toEqual(await readFile(fixture.documentPath));
    await expect(service.getEditorSource(8, preview.renderTree.documentId)).rejects.toThrow("Office 文档会话不存在");

    const archive = PackageArchive.open(source.bytes);
    const documentXml = new TextDecoder().decode(archive.read("word/document.xml"));
    const output = archive.replace(
      "word/document.xml",
      new TextEncoder().encode(documentXml.replace(">Test<", ">Direct edit<")),
    );
    const saved = await service.saveEditor(7, {
      documentId: source.documentId,
      revision: source.revision,
      sourceSha256: source.sourceSha256,
      bytes: output,
    });

    expect(saved.preview.renderTree).toMatchObject({
      documentId: source.documentId,
      revision: 2,
      root: { children: [{ runs: [{ text: "Direct edit" }] }] },
    });
    const refreshed = await service.getEditorSource(7, source.documentId);
    expect(refreshed.revision).toBe(2);
    expect(refreshed.sourceSha256).not.toBe(source.sourceSha256);
    expect(refreshed.bytes).toEqual(await readFile(fixture.documentPath));

    await expect(
      service.saveEditor(7, {
        documentId: source.documentId,
        revision: source.revision,
        sourceSha256: source.sourceSha256,
        bytes: output,
      }),
    ).rejects.toThrow("STALE_DOCUMENT");
  });

  it("直接编辑保存拒绝错误哈希、外部修改和无效 DOCX", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(9, fixture.projectId, "reports/document.docx");
    const source = await service.getEditorSource(9, preview.renderTree.documentId);

    await expect(service.saveEditor(9, { ...source, sourceSha256: "forged" })).rejects.toThrow("STALE_DOCUMENT");
    await expect(service.saveEditor(9, { ...source, bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow();
    expect(await readFile(fixture.documentPath)).toEqual(source.bytes);

    await writeFile(fixture.documentPath, "external edit");
    await expect(service.saveEditor(9, source)).rejects.toThrow("STALE_DOCUMENT");
  });

  it("外部修改后拒绝计划和提交", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(1, fixture.projectId, "reports/document.docx");
    const run = preview.renderTree.root.children[0]?.runs[0];
    if (!run) throw new Error("测试 DOCX 缺少文本运行");
    const input = operationInput(
      preview.renderTree.documentId,
      preview.renderTree.revision,
      preview.renderTree.root.children[0].id,
      run,
    );

    await writeFile(fixture.documentPath, "external edit");
    await expect(service.plan(1, input)).rejects.toThrow("STALE_DOCUMENT");

    await copyFile(fixturePath, fixture.documentPath);
    const reopened = await service.open(1, fixture.projectId, "reports/document.docx");
    const reopenedRun = reopened.renderTree.root.children[0]?.runs[0];
    if (!reopenedRun) throw new Error("测试 DOCX 缺少文本运行");
    const plan = await service.plan(
      1,
      operationInput(
        reopened.renderTree.documentId,
        reopened.renderTree.revision,
        reopened.renderTree.root.children[0].id,
        reopenedRun,
      ),
    );
    await writeFile(fixture.documentPath, "second external edit");
    await expect(
      service.commit(1, {
        documentId: reopened.renderTree.documentId,
        planId: plan.planId,
        planSha256: plan.planSha256,
      }),
    ).rejects.toThrow("STALE_DOCUMENT");
  });

  it("拒绝跨 renderer 句柄、伪造哈希和过期计划", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(11, fixture.projectId, "reports/document.docx");
    const run = preview.renderTree.root.children[0]?.runs[0];
    if (!run) throw new Error("测试 DOCX 缺少文本运行");
    const input = operationInput(
      preview.renderTree.documentId,
      preview.renderTree.revision,
      preview.renderTree.root.children[0].id,
      run,
    );

    await expect(service.plan(12, input)).rejects.toThrow("Office 文档会话不存在");
    const forged = await service.plan(11, input, 1_000);
    await expect(
      service.commit(
        11,
        { documentId: preview.renderTree.documentId, planId: forged.planId, planSha256: "forged" },
        1_001,
      ),
    ).rejects.toThrow("Office 文档计划校验失败");

    const expired = await service.plan(11, input, 2_000);
    await expect(
      service.commit(
        11,
        { documentId: preview.renderTree.documentId, planId: expired.planId, planSha256: expired.planSha256 },
        expired.expiresAt + 1,
      ),
    ).rejects.toThrow("TRANSACTION_EXPIRED");

    service.closeOwner(11);
    await expect(service.plan(11, input)).rejects.toThrow("Office 文档会话不存在");
  });

  it("为 Agent 提供有界检查和只读计划，并由 renderer 丢弃计划", async () => {
    const fixture = await createFixture();
    const notifications: Array<{ ownerId: number; planId: string }> = [];
    const service = new OfficeDocumentService(fixture.store, {
      onPlanCreated: (ownerId, plan) => notifications.push({ ownerId, planId: plan.planId }),
    });
    const preview = await service.open(19, fixture.projectId, "reports/document.docx");
    const paragraph = preview.renderTree.root.children[0];
    const run = paragraph?.runs[0];
    if (!paragraph || !run) throw new Error("测试 DOCX 缺少文本运行");

    const outline = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "outline",
      limit: 1,
    });
    expect(outline).toMatchObject({
      mode: "outline",
      documentId: preview.renderTree.documentId,
      revision: preview.renderTree.revision,
      paragraphs: [{ id: paragraph.id, textPreview: "Test", runCount: 1 }],
    });
    expect(outline.paragraphs).toHaveLength(1);

    const selected = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "paragraphs",
      paragraphIds: [paragraph.id],
    });
    expect(selected).toMatchObject({
      mode: "paragraphs",
      paragraphs: [{ id: paragraph.id, runs: [{ text: "Test" }] }],
    });

    const searched = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "search",
      text: "test",
      limit: 5,
    });
    expect(searched.paragraphs).toHaveLength(1);
    await expect(
      service.inspectForAgent("other-project", preview.renderTree.documentId, { mode: "outline" }),
    ).rejects.toThrow("Office 文档会话不存在");

    const plan = await service.planForAgent(
      fixture.projectId,
      operationInput(preview.renderTree.documentId, preview.renderTree.revision, paragraph.id, run),
    );
    expect(notifications).toEqual([{ ownerId: 19, planId: plan.planId }]);
    expect(plan).not.toHaveProperty("patches");

    service.discard(19, { documentId: preview.renderTree.documentId, planId: plan.planId });
    await expect(
      service.commit(19, {
        documentId: preview.renderTree.documentId,
        planId: plan.planId,
        planSha256: plan.planSha256,
      }),
    ).rejects.toThrow("无效的 Office 文档计划句柄");
  });

  it("Agent 规划等待磁盘检查时关闭 Project 不会留下孤儿计划", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(20, fixture.projectId, "reports/document.docx");
    const paragraph = preview.renderTree.root.children[0];
    const run = paragraph?.runs[0];
    if (!paragraph || !run) throw new Error("测试 DOCX 缺少文本运行");

    const pending = service.planForAgent(
      fixture.projectId,
      operationInput(preview.renderTree.documentId, preview.renderTree.revision, paragraph.id, run),
    );
    service.closeProject(fixture.projectId);

    await expect(pending).rejects.toThrow("Office 文档窗口已关闭");
    expect(service.listForAgent(fixture.projectId)).toEqual([]);
  });

  it("通过 Agent 计划和 renderer 批准提交跨运行范围", async () => {
    const fixture = await createFixture();
    const source = PackageArchive.open(await readFile(fixture.documentPath));
    const document =
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>One</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Two</w:t></w:r></w:p></w:body></w:document>';
    await writeFile(fixture.documentPath, source.replace("word/document.xml", new TextEncoder().encode(document)));
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(25, fixture.projectId, "reports/document.docx");
    const paragraph = preview.renderTree.root.children[0];
    const [first, second] = paragraph?.runs ?? [];
    if (!paragraph || !first || !second) throw new Error("测试 DOCX 缺少跨运行范围");
    const expectedText = "neTw";
    const plan = await service.planForAgent(fixture.projectId, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "replace_text_range",
            target: {
              part: "document",
              paragraphId: paragraph.id,
              start: { runId: first.id, offset: 1 },
              end: { runId: second.id, offset: 2 },
            },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText,
              expectedTextSha256: sha256Hex(new TextEncoder().encode(expectedText)),
            },
            replacement: "&",
          },
        ],
      },
    });
    expect(plan).toMatchObject({
      touchedRuns: [first.id, second.id],
      semanticDiff: [
        { runId: first.id, before: "One", after: "O&" },
        { runId: second.id, before: "Two", after: "o" },
      ],
    });
    const committed = await service.commit(25, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(committed.preview.renderTree.root.children[0]?.runs.map((run) => run.text)).toEqual(["O&", "o"]);
    expect(committed.preview.renderTree.root.children[0]?.runs[1]?.properties.italic).toBe(true);
  });

  it("通过 Agent 计划和 renderer 批准插入并删除段落", async () => {
    const fixture = await createFixture();
    const source = PackageArchive.open(await readFile(fixture.documentPath));
    const document =
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>C</w:t></w:r></w:p></w:body></w:document>';
    await writeFile(fixture.documentPath, source.replace("word/document.xml", new TextEncoder().encode(document)));
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(26, fixture.projectId, "reports/document.docx");
    const [first, second] = preview.renderTree.root.children;
    if (!first || !second) throw new Error("测试 DOCX 缺少段落");
    const plan = await service.planForAgent(fixture.projectId, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "insert_paragraph_after",
            target: { part: "document", paragraphId: first.id },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: "A",
              expectedTextSha256: first.textSha256,
            },
            replacement: " 新段落 ",
          },
          {
            type: "delete_paragraph",
            target: { part: "document", paragraphId: second.id },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: "B",
              expectedTextSha256: second.textSha256,
            },
          },
        ],
      },
    });
    expect(plan).toMatchObject({
      touchedParagraphs: [first.id, second.id],
      semanticDiff: [
        { type: "paragraph", paragraphId: first.id, change: "insert", before: "", after: " 新段落 " },
        { type: "paragraph", paragraphId: second.id, change: "delete", before: "B", after: "" },
      ],
    });
    const committed = await service.commit(26, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(
      committed.preview.renderTree.root.children.map((paragraph) => paragraph.runs.map((run) => run.text).join("")),
    ).toEqual(["A", " 新段落 ", "C"]);
  });

  it("通过 Agent 计划和 renderer 批准修改 run 样式", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(27, fixture.projectId, "reports/document.docx");
    const paragraph = preview.renderTree.root.children[0];
    const run = paragraph.runs[0];
    const before = {
      bold: run.properties.bold ?? false,
      italic: run.properties.italic ?? false,
      ...(run.properties.styleId === undefined ? {} : { styleId: run.properties.styleId }),
    };
    const after = { ...before, bold: !before.bold, italic: !before.italic };
    const plan = await service.planForAgent(fixture.projectId, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "set_text_run_style",
            target: { part: "document", paragraphId: paragraph.id, runId: run.id },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: run.text,
              expectedTextSha256: run.textSha256,
              expectedProperties: before,
            },
            replacement: { bold: after.bold, italic: after.italic },
          },
        ],
      },
    });
    expect(plan.semanticDiff).toEqual([
      {
        type: "run-style",
        runId: run.id,
        before,
        after,
      },
    ]);
    const committed = await service.commit(27, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(committed.preview.renderTree.root.children[0].runs[0]).toMatchObject({
      text: run.text,
      properties: after,
    });
  });

  it("关闭 Project 后撤销文档和计划句柄", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(21, fixture.projectId, "reports/document.docx");
    const paragraph = preview.renderTree.root.children[0];
    const run = paragraph?.runs[0];
    if (!paragraph || !run) throw new Error("测试 DOCX 缺少文本运行");
    const input = operationInput(preview.renderTree.documentId, preview.renderTree.revision, paragraph.id, run);
    const plan = await service.plan(21, input);

    service.closeProject(fixture.projectId);

    await expect(service.plan(21, input)).rejects.toThrow("Office 文档会话不存在");
    await expect(
      service.commit(21, {
        documentId: preview.renderTree.documentId,
        planId: plan.planId,
        planSha256: plan.planSha256,
      }),
    ).rejects.toThrow("Office 文档会话不存在");
  });

  it("按 LRU 和总字节预算回收打开的文档", async () => {
    const fixture = await createFixture();
    await copyFile(fixturePath, join(fixture.cwd, "reports", "second.docx"));
    await copyFile(fixturePath, join(fixture.cwd, "reports", "third.docx"));
    let now = 0;
    const service = new OfficeDocumentService(fixture.store, {
      maxOpenDocuments: 2,
      maxOpenDocumentBytes: 256 * 1024 * 1024,
      now: () => now,
    });
    try {
      const first = await service.open(1, fixture.projectId, "reports/document.docx");
      now = 1;
      const second = await service.open(2, fixture.projectId, "reports/second.docx");
      now = 2;
      await service.inspectForAgent(fixture.projectId, first.renderTree.documentId, { mode: "outline" });
      now = 3;
      const third = await service.open(3, fixture.projectId, "reports/third.docx");

      await expect(
        service.inspectForAgent(fixture.projectId, second.renderTree.documentId, { mode: "outline" }),
      ).rejects.toThrow("Office 文档会话不存在");
      await expect(
        service.inspectForAgent(fixture.projectId, first.renderTree.documentId, { mode: "outline" }),
      ).resolves.toMatchObject({ documentId: first.renderTree.documentId });
      await expect(
        service.inspectForAgent(fixture.projectId, third.renderTree.documentId, { mode: "outline" }),
      ).resolves.toMatchObject({ documentId: third.renderTree.documentId });
    } finally {
      service.dispose();
    }

    const fixtureBytes = (await readFile(fixturePath)).byteLength;
    const byteBounded = new OfficeDocumentService(fixture.store, {
      maxOpenDocumentBytes: fixtureBytes * 2 - 1,
    });
    try {
      const first = await byteBounded.open(4, fixture.projectId, "reports/document.docx");
      const second = await byteBounded.open(5, fixture.projectId, "reports/second.docx");
      await expect(
        byteBounded.inspectForAgent(fixture.projectId, first.renderTree.documentId, { mode: "outline" }),
      ).rejects.toThrow("Office 文档会话不存在");
      await expect(
        byteBounded.inspectForAgent(fixture.projectId, second.renderTree.documentId, { mode: "outline" }),
      ).resolves.toMatchObject({ documentId: second.renderTree.documentId });
    } finally {
      byteBounded.dispose();
    }
  });

  it("通过 idle timer 主动释放文档和关联计划", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const service = new OfficeDocumentService(fixture.store, {
      idleTimeoutMs: 1_000,
      idleSweepIntervalMs: 100,
      now: Date.now,
    });
    try {
      const preview = await service.open(7, fixture.projectId, "reports/document.docx");
      const paragraph = preview.renderTree.root.children[0];
      const run = paragraph?.runs[0];
      if (!paragraph || !run) throw new Error("测试 DOCX 缺少文本运行");
      const plan = await service.plan(
        7,
        operationInput(preview.renderTree.documentId, preview.renderTree.revision, paragraph.id, run),
      );

      await vi.advanceTimersByTimeAsync(1_100);

      await expect(
        service.commit(7, {
          documentId: preview.renderTree.documentId,
          planId: plan.planId,
          planSha256: plan.planSha256,
        }),
      ).rejects.toThrow("Office 文档会话不存在");
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("记录不包含正文的 transaction audit", async () => {
    const fixture = await createFixture();
    const audits: unknown[] = [];
    const service = new OfficeDocumentService(fixture.store, { onAudit: (audit) => audits.push(audit) });
    try {
      const preview = await service.open(31, fixture.projectId, "reports/document.docx");
      const paragraph = preview.renderTree.root.children[0];
      const run = paragraph?.runs[0];
      if (!paragraph || !run) throw new Error("测试 DOCX 缺少文本运行");
      const input = operationInput(preview.renderTree.documentId, preview.renderTree.revision, paragraph.id, run);
      input.envelope.operations[0].replacement = "HIGHLY_SENSITIVE_REPLACEMENT";
      const discarded = await service.plan(31, input, 1_000);
      service.discard(31, { documentId: preview.renderTree.documentId, planId: discarded.planId });
      const failed = await service.plan(31, input, 2_000);
      await expect(
        service.commit(
          31,
          { documentId: preview.renderTree.documentId, planId: failed.planId, planSha256: "forged" },
          2_001,
        ),
      ).rejects.toThrow("Office 文档计划校验失败");
      const committed = await service.plan(31, input, 3_000);
      await service.commit(
        31,
        {
          documentId: preview.renderTree.documentId,
          planId: committed.planId,
          planSha256: committed.planSha256,
        },
        3_001,
      );

      expect(audits).toMatchObject([
        { status: "planned", operationTypes: ["replace_text_run"], operationCount: 1 },
        { status: "rejected", operationTypes: ["replace_text_run"], completedAt: expect.any(Number) },
        { status: "planned", operationTypes: ["replace_text_run"], operationCount: 1 },
        { status: "failed", errorCode: "PLAN_HASH_MISMATCH", completedAt: 2_001 },
        { status: "planned", operationTypes: ["replace_text_run"], operationCount: 1 },
        { status: "approved", approvedAt: 3_001, approvalChannel: "renderer_user" },
        {
          status: "committed",
          approvedAt: 3_001,
          approvalChannel: "renderer_user",
          completedAt: 3_001,
          outputSha256: expect.any(String),
        },
      ]);
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain("HIGHLY_SENSITIVE_REPLACEMENT");
      expect(serialized).not.toContain(run.text);
      expect(serialized).not.toContain("before");
      expect(serialized).not.toContain("after");
    } finally {
      service.dispose();
    }
  });

  it("显式检查并提交已有批注文本", async () => {
    const fixture = await createFixture(new Uint8Array(await readFile(commentsFixturePath)));
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(32, fixture.projectId, "reports/document.docx");
    const comment = preview.renderTree.root.comments[0];
    const paragraph = comment?.paragraphs[0];
    const run = paragraph?.runs.find((candidate) => candidate.editable);
    if (!comment || !paragraph || !run) throw new Error("测试 DOCX 缺少可编辑批注文本");
    const defaultOutline = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "outline",
    });
    expect(defaultOutline.paragraphs.some((item) => item.part === "comments")).toBe(false);
    const commentOutline = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "outline",
      parts: ["comments"],
    });
    expect(commentOutline.paragraphs).toMatchObject([
      { part: "comments", commentId: comment.id, commentAuthor: "Michael Williamson" },
      { part: "comments", commentId: "comment:rId6:2", commentAuthor: "Michael Williamson" },
    ]);
    const plan = await service.planForAgent(fixture.projectId, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "replace_comment_text_run",
            target: { part: "comments", commentId: comment.id, paragraphId: paragraph.id, runId: run.id },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: run.text,
              expectedTextSha256: run.textSha256,
            },
            replacement: "Desktop reviewed.",
          },
        ],
      },
    });
    expect(plan).toMatchObject({
      touchedParts: ["word/comments.xml"],
      semanticDiff: [{ type: "comment-text", commentId: comment.id, after: "Desktop reviewed." }],
    });
    const committed = await service.commit(32, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(committed.preview.renderTree.root.comments[0]?.paragraphs[0]?.runs.find((item) => item.editable)?.text).toBe(
      "Desktop reviewed.",
    );
  });

  it("检查、规划并提交页眉页脚文本", async () => {
    const fixture = await createFixture(relatedPartsFixture());
    const service = new OfficeDocumentService(fixture.store);
    const preview = await service.open(31, fixture.projectId, "reports/document.docx");
    expect(preview.renderTree.root.relatedParts.map((part) => part.kind)).toEqual(["footer", "header"]);
    const header = preview.renderTree.root.relatedParts.find((part) => part.kind === "header");
    const paragraph = header?.paragraphs[0];
    const run = paragraph?.runs[0];
    if (!header || !paragraph || !run) throw new Error("测试 DOCX 缺少页眉文本运行");

    const outline = await service.inspectForAgent(fixture.projectId, preview.renderTree.documentId, {
      mode: "outline",
      parts: ["header"],
    });
    expect(outline.paragraphs).toMatchObject([
      { id: paragraph.id, part: "header", relatedPartId: header.id, textPreview: "Header" },
    ]);

    const plan = await service.planForAgent(fixture.projectId, {
      documentId: preview.renderTree.documentId,
      envelope: {
        protocolVersion: 1,
        operations: [
          {
            type: "replace_related_text_run",
            target: {
              part: "header",
              relatedPartId: header.id,
              paragraphId: paragraph.id,
              runId: run.id,
            },
            precondition: {
              documentRevision: preview.renderTree.revision,
              expectedText: run.text,
              expectedTextSha256: run.textSha256,
            },
            replacement: "Approved Header",
          },
        ],
      },
    });
    expect(plan).toMatchObject({
      touchedParts: ["word/header1.xml"],
      semanticDiff: [{ type: "related-text", part: "header", relatedPartId: header.id, after: "Approved Header" }],
    });
    const committed = await service.commit(31, {
      documentId: preview.renderTree.documentId,
      planId: plan.planId,
      planSha256: plan.planSha256,
    });
    expect(
      committed.preview.renderTree.root.relatedParts.find((part) => part.kind === "header")?.paragraphs[0]?.runs[0]
        ?.text,
    ).toBe("Approved Header");
    expect(
      new TextDecoder().decode(PackageArchive.open(await readFile(fixture.documentPath)).read("word/header1.xml")),
    ).toContain("Approved Header");
  });

  it.skipIf(process.platform === "win32")("拒绝通过 symlink 打开 Project 外 DOCX", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside.docx");
    await copyFile(fixturePath, outside);
    await symlink(outside, join(fixture.cwd, "reports", "linked.docx"));

    await expect(
      new OfficeDocumentService(fixture.store).open(1, fixture.projectId, "reports/linked.docx"),
    ).rejects.toThrow("文件路径超出 Project cwd");
  });
});

function operationInput(
  documentId: string,
  revision: number,
  paragraphId: string,
  run: { id: string; text: string; textSha256: string },
) {
  return {
    documentId,
    envelope: {
      protocolVersion: 1 as const,
      operations: [
        {
          type: "replace_text_run" as const,
          target: { part: "document" as const, paragraphId, runId: run.id },
          precondition: { documentRevision: revision, expectedText: run.text, expectedTextSha256: run.textSha256 },
          replacement: "Replacement",
        },
      ],
    },
  };
}

async function createFixture(sourceBytes?: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-office-document-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const documentPath = join(cwd, "reports", "document.docx");
  await mkdir(join(cwd, "reports"), { recursive: true });
  if (sourceBytes) await writeFile(documentPath, sourceBytes);
  else await copyFile(fixturePath, documentPath);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  expect(await readFile(documentPath)).not.toHaveLength(0);
  return { root, cwd, documentPath, projectId: project.id, store };
}

function relatedPartsFixture(): Uint8Array {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  return zipSync({
    "[Content_Types].xml": encode(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
    ),
    "_rels/.rels": encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": encode(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>',
    ),
    "word/_rels/document.xml.rels": encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
    ),
    "word/header1.xml": encode(
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>',
    ),
    "word/footer1.xml": encode(
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>',
    ),
  });
}
