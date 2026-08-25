import { describe, expect, it } from "vitest";
import { getAttachmentFileKind } from "../src/renderer/src/components/assistant-ui/attachment/attachment-file-kind.ts";

describe("attachment file kind", () => {
  it.each([
    ["manual.PDF", "application/octet-stream", "pdf"],
    ["report.docx", "application/octet-stream", "word"],
    ["legacy.doc", "application/msword", "word"],
    ["budget.xlsx", "application/octet-stream", "spreadsheet"],
    ["data", "text/csv", "spreadsheet"],
    ["deck.pptx", "application/octet-stream", "presentation"],
    ["source.zip", "application/octet-stream", "archive"],
    ["index.ts", "application/octet-stream", "code"],
    ["voice.mp3", "audio/mpeg", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["installer.exe", "application/octet-stream", "executable"],
    ["unknown.bin", "application/octet-stream", "generic"],
  ] as const)("maps %s to %s", (name, contentType, expected) => {
    expect(getAttachmentFileKind(name, contentType)).toBe(expected);
  });
});
