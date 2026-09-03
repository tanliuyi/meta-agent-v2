import { describe, expect, it, vi } from "vitest";
import {
  createAttachmentAdapter,
  parsePiFileContexts,
  restoreComposerAttachments,
  toComposerAttachmentInput,
  toPiPromptAttachments,
} from "../src/renderer/src/runtime/attachments.ts";

describe("assistant-ui 附件", () => {
  const testAttachmentAdapter = createAttachmentAdapter((file) => `C:\\images\\${file.name}`);

  it("将 pending 图片转换为 Pi IPC 输入", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
    const attachment = await testAttachmentAdapter.add({ file });

    await expect(
      toPiPromptAttachments("查看截图", [attachment], (pending) => testAttachmentAdapter.send(pending)),
    ).resolves.toEqual({
      text: expect.stringContaining('<file name="C:\\images\\screen.png">screen.png</file>'),
      images: [
        {
          name: "screen.png",
          mimeType: "image/png",
          data: "AQID",
        },
      ],
    });
  });

  it("图片同时保留源路径和当前请求的图像数据", async () => {
    const adapter = createAttachmentAdapter(() => "C:\\images\\screen.png");
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
    const attachment = await adapter.add({ file });
    const prompt = await toPiPromptAttachments("查看截图", [attachment], (pending) =>
      testAttachmentAdapter.send(pending),
    );

    expect(prompt.images).toEqual([{ name: "screen.png", mimeType: "image/png", data: "AQID" }]);
    expect(parsePiFileContexts(prompt.text)).toEqual({
      text: "查看截图",
      files: [{ path: "C:\\images\\screen.png", name: "screen.png" }],
    });
  });

  it("剪贴板截图没有源路径时仍只发送图片数据", async () => {
    const adapter = createAttachmentAdapter(() => "");
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const attachment = await adapter.add({ file });

    await expect(toPiPromptAttachments("分析截图", [attachment], (pending) => adapter.send(pending))).resolves.toEqual({
      text: "分析截图",
      images: [{ name: "image.png", mimeType: "image/png", data: "AQID" }],
    });
  });

  it("为同名剪贴板图片生成不同的附件 ID", async () => {
    const first = await testAttachmentAdapter.add({
      file: new File([new Uint8Array([1])], "image.png", { type: "image/png" }),
    });
    const second = await testAttachmentAdapter.add({
      file: new File([new Uint8Array([2])], "image.png", { type: "image/png" }),
    });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("image.png");
    expect(second.name).toBe("image.png");
  });

  it("接受非图片文件并保留路径和文件名供 chip 恢复", async () => {
    const adapter = createAttachmentAdapter(() => "C:\\docs\\report.docx");
    const file = new File([], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const pending = await adapter.add({ file });
    const complete = await adapter.send(pending);

    expect(adapter.accept).toBe("*");
    expect(pending).toMatchObject({
      type: "file",
      name: "report.docx",
      content: [
        {
          type: "file",
          data: "C:\\docs\\report.docx",
          filename: "report.docx",
        },
      ],
    });
    expect(complete.status).toEqual({ type: "complete" });
    expect(toComposerAttachmentInput(complete)).toEqual({
      id: complete.id,
      type: "file",
      name: "report.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: complete.content,
    });
    const addAttachment = vi.fn(async () => {});
    await restoreComposerAttachments(addAttachment, [complete], new Set());
    expect(addAttachment).toHaveBeenCalledWith(toComposerAttachmentInput(complete));
    const prompt = await toPiPromptAttachments("分析附件", [complete]);
    const marker = `<pi-file-context-v1>${JSON.stringify({
      files: [{ path: "C:\\docs\\report.docx", name: "report.docx" }],
    })}</pi-file-context-v1>`;
    expect(prompt).toEqual({
      text: `分析附件\n\n${marker}\n\n<file name="C:\\docs\\report.docx">report.docx</file>`,
      images: [],
    });
    // round-trip：发送文本可逆恢复为附件 + 正文。
    expect(parsePiFileContexts(prompt.text)).toEqual({
      text: "分析附件",
      files: [{ path: "C:\\docs\\report.docx", name: "report.docx" }],
    });
  });

  it("拒绝没有磁盘路径的非图片附件", async () => {
    const adapter = createAttachmentAdapter(() => "");
    const file = new File([], "memory.docx", { type: "application/octet-stream" });

    await expect(adapter.add({ file })).rejects.toThrow("无法读取附件路径: memory.docx");
  });

  it("转义文件路径和文件名，并支持仅附件 prompt", async () => {
    const attachment = {
      id: "file-1",
      type: "file" as const,
      name: 'draft<&>".docx',
      status: { type: "complete" as const },
      content: [
        {
          type: "file" as const,
          data: 'C:\\A&B\\"draft".docx',
          filename: 'draft<&>".docx',
          mimeType: "application/octet-stream",
        },
      ],
    };
    const prompt = await toPiPromptAttachments("", [attachment]);
    // Pi 侧 file 行保持单行 XML 转义格式（尾部），标记行携带 JSON 载荷提供来源与精确解码。
    expect(prompt.text).toMatch(
      /^<pi-file-context-v1>\{.*\}<\/pi-file-context-v1>\n\n<file name="C:\\A&amp;B\\&quot;draft&quot;\.docx">draft&lt;&amp;&gt;&quot;\.docx<\/file>$/,
    );
    const markerLine = prompt.text.split("\n")[0]!;
    const payload = JSON.parse(markerLine.slice("<pi-file-context-v1>".length, -"</pi-file-context-v1>".length)) as {
      files?: unknown;
    };
    expect(payload).toEqual({ files: [{ path: 'C:\\A&B\\"draft".docx', name: 'draft<&>".docx' }] });
    expect(parsePiFileContexts(prompt.text)).toEqual({
      text: "",
      files: [{ path: 'C:\\A&B\\"draft".docx', name: 'draft<&>".docx' }],
    });
  });

  it("只解析带版本标记的文件上下文，普通尾部 file 示例保持为正文", () => {
    const inline = '示例 <file name="C:\\one.txt">one.txt</file> 仍是正文';
    const trailing =
      '用户展示的示例\n\n<file name="C:\\one.txt">one.txt</file>\n<file name="C:\\two.exe">two&lt;&amp;&gt;.exe</file>';
    const markerless = '<file name="C:\\one.txt">one.txt</file>';

    expect(parsePiFileContexts(inline)).toEqual({ text: inline, files: [] });
    expect(parsePiFileContexts(trailing)).toEqual({ text: trailing, files: [] });
    expect(parsePiFileContexts(markerless)).toEqual({ text: markerless, files: [] });
  });

  it("拒绝数量、内容或 JSON 不一致的伪文件上下文标记", () => {
    const countMismatch =
      '<pi-file-context-v1>{"files":[{"path":"C:\\a.txt","name":"a.txt"},{"path":"C:\\b.txt","name":"b.txt"}]}</pi-file-context-v1>\n\n<file name="C:\\a.txt">a.txt</file>';
    const malformed =
      '<pi-file-context-v1>{"files":[{"path":1,"name":null}]}</pi-file-context-v1>\n\n<file name="C:\\a.txt">a.txt</file>';
    const contentMismatch = String.raw`<pi-file-context-v1>{"files":[{"path":"C:\\declared.txt","name":"declared.txt"}]}</pi-file-context-v1>

<file name="C:\actual.txt">actual.txt</file>`;

    expect(parsePiFileContexts(countMismatch)).toEqual({ text: countMismatch, files: [] });
    expect(parsePiFileContexts(malformed)).toEqual({ text: malformed, files: [] });
    expect(parsePiFileContexts(contentMismatch)).toEqual({ text: contentMismatch, files: [] });
  });

  it("保留已完成图片附件的文件名", async () => {
    await expect(
      toPiPromptAttachments("", [
        {
          id: "image-1",
          type: "image",
          name: "fallback.png",
          status: { type: "complete" },
          content: [{ type: "image", image: "data:image/jpeg;base64,/9j/", filename: "photo.jpg" }],
        },
      ]),
    ).resolves.toEqual({
      text: "",
      images: [
        {
          name: "photo.jpg",
          mimeType: "image/jpeg",
          data: "/9j/",
        },
      ],
    });
  });

  it("并行完成 pending 附件，并按 Composer 顺序展开结果", async () => {
    const first = await testAttachmentAdapter.add({
      file: new File([new Uint8Array([1])], "first.png", { type: "image/png" }),
    });
    const second = await testAttachmentAdapter.add({
      file: new File([new Uint8Array([2])], "second.png", { type: "image/png" }),
    });
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const converting = toPiPromptAttachments("prompt", [first, second], async (attachment) => {
      started.push(attachment.id);
      await new Promise<void>((resolve) => releases.set(attachment.id, resolve));
      return {
        id: attachment.id,
        type: "image",
        name: attachment.name,
        contentType: "image/png",
        status: { type: "complete" },
        content: [{ type: "image", image: `data:image/png;base64,${attachment.id}` }],
      };
    });

    expect(started).toEqual([first.id, second.id]);
    releases.get(second.id)?.();
    releases.get(first.id)?.();
    await expect(converting).resolves.toEqual({
      text: "prompt",
      images: [
        { name: "first.png", mimeType: "image/png", data: first.id },
        { name: "second.png", mimeType: "image/png", data: second.id },
      ],
    });
  });
});
