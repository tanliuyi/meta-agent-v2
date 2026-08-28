import type {
  DocxDocumentPreview,
  OfficeDocumentPreview as OfficeDocumentPreviewData,
  XlsxDocumentPreview,
} from "../../../../../shared/office-document-contracts.ts";
import { DocxDocumentPreviewView } from "./docx-document-preview.tsx";
import { LegacyOfficeDocumentPreviewView } from "./legacy-office-document-preview.tsx";
import { XlsxDocumentPreviewView } from "./xlsx-document-preview.tsx";

export function OfficeDocumentPreview({
  preview,
  onCommitted,
}: {
  preview: OfficeDocumentPreviewData;
  onCommitted?(preview: DocxDocumentPreview | XlsxDocumentPreview): void;
}) {
  if (preview.kind === "legacy-html") return <LegacyOfficeDocumentPreviewView preview={preview} />;
  if (preview.kind === "xlsx") return <XlsxDocumentPreviewView preview={preview} onCommitted={onCommitted} />;
  return <DocxDocumentPreviewView preview={preview} onCommitted={onCommitted} />;
}
