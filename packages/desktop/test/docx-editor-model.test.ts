import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  docxToEditorContent,
  editorContentToSaveBlocks,
} from "../src/renderer/src/components/panel/files/docx-editor-model.ts";
import { parseDocx } from "../src/renderer/src/vendor/genoffice-docx-engine/parse.ts";
import { saveDocx } from "../src/renderer/src/vendor/genoffice-docx-engine/patch.ts";

const fixturePath = join(import.meta.dirname, "../../office-engine/test/corpus/strict-format.docx");

describe("DOCX editor model", () => {
  it("未编辑内容全部复用原始块并保持文件字节不变", async () => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    const parsed = await parseDocx(bytes);
    const content = docxToEditorContent(parsed);
    const saveBlocks = editorContentToSaveBlocks(content, parsed);

    expect(saveBlocks).toHaveLength(parsed.blocks.filter((block) => !block.hidden).length);
    expect(saveBlocks.every((block) => block.kind === "original")).toBe(true);
    expect(await saveDocx(parsed, saveBlocks)).toEqual(bytes);
  });

  it("范围删除后自动补回不可编辑的原始块", async () => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    const parsed = await parseDocx(bytes);
    const first = parsed.blocks.find((block) => !block.hidden && block.docxIndex !== null);
    if (!first || first.docxIndex === null) throw new Error("测试 DOCX 缺少可定位块");
    const protectedDocument = {
      ...parsed,
      blocks: parsed.blocks.map((block) =>
        block === first ? { ...block, type: "table" as const, label: "表格" } : block,
      ),
    };
    const content = docxToEditorContent(protectedDocument);
    content.content = content.content?.filter((node) => node.type !== "protectedBlock");

    const saveBlocks = editorContentToSaveBlocks(content, protectedDocument);
    expect(saveBlocks).toContainEqual({ kind: "original", docxIndex: first.docxIndex });
  });

  it("只重建编辑过的段落并保留其余原始块", async () => {
    const bytes = new Uint8Array(await readFile(fixturePath));
    const parsed = await parseDocx(bytes);
    const content = docxToEditorContent(parsed);
    const paragraph = content.content?.find((node) => node.type === "paragraph");
    const text = paragraph?.content?.find((node) => node.type === "text");
    if (!paragraph || !text || typeof text.text !== "string") throw new Error("测试 DOCX 缺少文本段落");

    text.text = "Edited in Desktop";
    paragraph.attrs = {
      ...paragraph.attrs,
      format: { ...(isRecord(paragraph.attrs?.format) ? paragraph.attrs.format : {}), align: "center" },
    };
    const saveBlocks = editorContentToSaveBlocks(content, parsed);
    expect(saveBlocks.filter((block) => block.kind === "generated")).toHaveLength(1);

    const output = await saveDocx(parsed, saveBlocks);
    const reparsed = await parseDocx(output);
    expect(reparsed.blocks.find((block) => block.runs?.some((run) => run.text === "Edited in Desktop"))).toBeDefined();
    expect(
      reparsed.blocks.find((block) => block.runs?.some((run) => run.text === "Edited in Desktop"))?.format?.align,
    ).toBe("center");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
