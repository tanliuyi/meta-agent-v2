import type { JSONContent } from "@tiptap/core";
import { mergePPrFormat } from "../../../vendor/genoffice-docx-engine/generate.ts";
import type { ParsedDocFull, SaveBlock } from "../../../vendor/genoffice-docx-engine/patch.ts";
import type { Block, GeneratedBlock, Run } from "../../../vendor/genoffice-docx-engine/types.ts";

const EDITABLE_BLOCK_TYPES = new Set<Block["type"]>(["paragraph", "heading", "listItem"]);

export function docxToEditorContent(parsed: ParsedDocFull): JSONContent {
  const content = parsed.blocks.filter((block) => !block.hidden).map(blockToEditorNode);
  return {
    type: "doc",
    content:
      content.length > 0
        ? content
        : [
            {
              type: "paragraph",
              attrs: editorParagraphAttrs(),
            },
          ],
  };
}

export function editorContentToSaveBlocks(content: JSONContent, parsed: ParsedDocFull): SaveBlock[] {
  const originals = new Map(
    parsed.blocks
      .filter((block) => !block.hidden && block.docxIndex !== null)
      .map((block) => [block.docxIndex as number, block]),
  );
  const usedIndexes = new Set<number>();
  const protectedIndexes = parsed.blocks
    .filter(
      (block) =>
        !block.hidden &&
        block.docxIndex !== null &&
        (!EDITABLE_BLOCK_TYPES.has(block.type) || hasUnsupportedInlineContent(block)),
    )
    .map((block) => block.docxIndex as number);
  let protectedCursor = 0;
  const saveBlocks: SaveBlock[] = [];

  const restoreProtectedBefore = (docxIndex: number) => {
    while (protectedCursor < protectedIndexes.length && protectedIndexes[protectedCursor] < docxIndex) {
      const protectedIndex = protectedIndexes[protectedCursor++];
      if (!usedIndexes.has(protectedIndex)) {
        usedIndexes.add(protectedIndex);
        saveBlocks.push({ kind: "original", docxIndex: protectedIndex });
      }
    }
  };

  for (const node of content.content ?? []) {
    const docxIndex = numericAttr(node, "docxIndex");
    if (docxIndex !== null) restoreProtectedBefore(docxIndex);
    const original = docxIndex === null ? undefined : originals.get(docxIndex);
    if (node.type === "protectedBlock") {
      if (original && !usedIndexes.has(docxIndex as number)) {
        usedIndexes.add(docxIndex as number);
        saveBlocks.push({ kind: "original", docxIndex: docxIndex as number });
      }
      if (protectedIndexes[protectedCursor] === docxIndex) protectedCursor += 1;
      continue;
    }

    const generated = editorNodeToGeneratedBlock(node);
    if (!generated) continue;
    if (original && !usedIndexes.has(docxIndex as number)) {
      usedIndexes.add(docxIndex as number);
      if (canonical(comparableBlock(original)) === canonical(comparableBlock(generated))) {
        saveBlocks.push({ kind: "original", docxIndex: docxIndex as number });
        continue;
      }
      preserveParagraphAnchors(generated, original);
    }
    saveBlocks.push({ kind: "generated", block: generated });
  }

  restoreProtectedBefore(Number.POSITIVE_INFINITY);
  return saveBlocks;
}

export function firstListId(parsed: ParsedDocFull, kind: "bullet" | "ordered"): string | null {
  return parsed.blocks.find((block) => block.list?.kind === kind)?.list?.numId ?? null;
}

function blockToEditorNode(block: Block): JSONContent {
  if (!EDITABLE_BLOCK_TYPES.has(block.type) || hasUnsupportedInlineContent(block)) {
    return {
      type: "protectedBlock",
      attrs: {
        docxIndex: block.docxIndex,
        label: block.label ?? protectedBlockLabel(block),
        previewText: block.previewText ?? paragraphText(block),
        imageDataUrl: block.imageDataUrl ?? null,
      },
    };
  }
  return {
    type: "paragraph",
    attrs: editorParagraphAttrs(block),
    content: (block.runs ?? []).flatMap((run, runIndex) => runToEditorNodes(run, runIndex)),
  };
}

function editorParagraphAttrs(block?: Block): Record<string, unknown> {
  return {
    docxIndex: block?.docxIndex ?? null,
    blockType: block?.type ?? "paragraph",
    level: block?.level ?? null,
    styleId: block?.styleId ?? null,
    listKind: block?.list?.kind ?? null,
    numId: block?.list?.numId ?? null,
    ilvl: block?.list?.ilvl ?? null,
    format: block?.format ?? null,
  };
}

function runToEditorNodes(run: Run, runIndex: number): JSONContent[] {
  if (run.text.length === 0) return [];
  const marks: NonNullable<JSONContent["marks"]> = [{ type: "docRun", attrs: { runIndex, source: run } }];
  if (run.bold) marks.push({ type: "bold" });
  if (run.italic) marks.push({ type: "italic" });
  if (run.underline) marks.push({ type: "underline" });
  if (run.strike) marks.push({ type: "strike" });
  const format = {
    color: run.color ?? null,
    font: run.font ?? null,
    fontAscii: run.fontAscii ?? null,
    sizeHalfPoints: run.sizeHalfPoints ?? null,
    highlight: run.highlight ?? null,
  };
  if (Object.values(format).some((value) => value !== null)) {
    marks.push({ type: "docFormat", attrs: format });
  }
  return [{ type: "text", text: run.text, marks }];
}

function editorNodeToGeneratedBlock(node: JSONContent): GeneratedBlock | null {
  if (node.type !== "paragraph") return null;
  const runs = mergeAdjacentRuns((node.content ?? []).flatMap(editorInlineToRuns));
  const blockType = stringAttr(node, "blockType");
  const type: GeneratedBlock["type"] = blockType === "heading" || blockType === "listItem" ? blockType : "paragraph";
  const generated: GeneratedBlock = {
    type,
    runs: runs.length > 0 ? runs : [{ text: "" }],
  };
  const level = numericAttr(node, "level");
  const styleId = stringAttr(node, "styleId");
  const format = objectAttr(node, "format");
  if (type === "heading" && level !== null) generated.level = level;
  if (styleId) generated.styleId = styleId;
  if (format) generated.format = format as GeneratedBlock["format"];
  if (type === "listItem") {
    const numId = stringAttr(node, "numId");
    const listKind = stringAttr(node, "listKind");
    if (numId && (listKind === "bullet" || listKind === "ordered")) {
      generated.list = {
        kind: listKind,
        numId,
        ilvl: numericAttr(node, "ilvl") ?? 0,
      };
    } else {
      generated.type = "paragraph";
    }
  }
  return generated;
}

function editorInlineToRuns(node: JSONContent): Run[] {
  if (node.type === "hardBreak") return [{ text: "\n" }];
  if (node.type !== "text" || typeof node.text !== "string") return [];
  const sourceMark = node.marks?.find((mark) => mark.type === "docRun");
  const source = sourceMark?.attrs?.source;
  const run: Run = isRun(source) ? { ...source } : { text: "" };
  run.text = node.text;
  setRunFlag(run, "bold", hasMark(node, "bold"));
  setRunFlag(run, "italic", hasMark(node, "italic"));
  setRunFlag(run, "underline", hasMark(node, "underline"));
  setRunFlag(run, "strike", hasMark(node, "strike"));

  const format = node.marks?.find((mark) => mark.type === "docFormat")?.attrs;
  setRunString(run, "color", format?.color);
  setRunString(run, "font", format?.font);
  setRunString(run, "fontAscii", format?.fontAscii);
  setRunString(run, "highlight", format?.highlight);
  const size = typeof format?.sizeHalfPoints === "number" ? format.sizeHalfPoints : null;
  if (size !== null) run.sizeHalfPoints = size;
  else delete run.sizeHalfPoints;
  return [run];
}

function preserveParagraphAnchors(generated: GeneratedBlock, original: Block): void {
  if (original.rawPPr !== undefined) {
    generated.rawPPr =
      canonical(original.format ?? null) === canonical(generated.format ?? null)
        ? original.rawPPr
        : mergePPrFormat(original.rawPPr, generated.format);
  }
  if (original.bookmarks) generated.bookmarks = original.bookmarks;
  if (original.hiddenBookmarks) generated.hiddenBookmarks = original.hiddenBookmarks;
  if (original.commentStarts) generated.commentStarts = original.commentStarts;
  if (original.commentEnds) generated.commentEnds = original.commentEnds;
  if (original.sdtShell) generated.sdtShell = original.sdtShell;
  if (original.pPrChangeInfo) generated.pPrChange = JSON.stringify(original.pPrChangeInfo);
  if (original.blockRevision) generated.blockRevision = original.blockRevision;
}

function comparableBlock(block: Block | GeneratedBlock): unknown {
  return {
    type: block.type,
    level: block.level ?? null,
    styleId: block.styleId ?? null,
    list: block.list ?? null,
    format: block.format ?? null,
    runs: block.runs ?? [],
  };
}

function mergeAdjacentRuns(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && canonical(runStyle(previous)) === canonical(runStyle(run))) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function runStyle(run: Run): Omit<Run, "text"> {
  const { text: _text, ...style } = run;
  return style;
}

function hasUnsupportedInlineContent(block: Block): boolean {
  return (block.runs ?? []).some(
    (run) =>
      run.image !== undefined ||
      run.math !== undefined ||
      run.ruby !== undefined ||
      run.noteRef !== undefined ||
      run.fldBeginXml !== undefined,
  );
}

function protectedBlockLabel(block: Block): string {
  if (block.type === "table") return "表格";
  if (block.type === "image") return "图片";
  if (block.formulaDisplay) return "公式";
  if (block.chartDisplay) return "图表";
  return "受保护的文档内容";
}

function paragraphText(block: Block): string {
  return (block.runs ?? []).map((run) => run.text).join("");
}

function hasMark(node: JSONContent, type: string): boolean {
  return node.marks?.some((mark) => mark.type === type) ?? false;
}

function setRunFlag(run: Run, key: "bold" | "italic" | "underline" | "strike", value: boolean): void {
  if (value) run[key] = true;
  else delete run[key];
}

function setRunString(run: Run, key: "color" | "font" | "fontAscii" | "highlight", value: unknown): void {
  if (typeof value === "string" && value.length > 0) run[key] = value;
  else delete run[key];
}

function numericAttr(node: JSONContent, key: string): number | null {
  const value = node.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAttr(node: JSONContent, key: string): string | null {
  const value = node.attrs?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectAttr(node: JSONContent, key: string): Record<string, unknown> | null {
  const value = node.attrs?.[key];
  return isRecord(value) ? value : null;
}

function isRun(value: unknown): value is Run {
  return isRecord(value) && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
