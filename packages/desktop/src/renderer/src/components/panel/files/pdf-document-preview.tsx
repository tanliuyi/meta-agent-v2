import type { PdfDocumentPreview as PdfDocumentPreviewData } from "../../../../../shared/contracts.ts";

export function PdfDocumentPreview({ preview }: { preview: PdfDocumentPreviewData }) {
  return (
    <iframe
      className="file-preview-pdf"
      title={`${preview.path} PDF 预览`}
      referrerPolicy="no-referrer"
      src={preview.url}
    />
  );
}
