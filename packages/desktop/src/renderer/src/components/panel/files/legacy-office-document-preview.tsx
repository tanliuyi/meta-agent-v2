import type { LegacyOfficeDocumentPreview } from "../../../../../shared/office-document-contracts.ts";

const OFFICE_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export function secureOfficeDocumentHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${OFFICE_PREVIEW_CSP}">`;
  const encoded = html
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html><head>${meta}</head><body><iframe title="Office 文档内容" sandbox="" referrerpolicy="no-referrer" srcdoc="${encoded}"></iframe></body></html>`;
}

export function LegacyOfficeDocumentPreviewView({ preview }: { preview: LegacyOfficeDocumentPreview }) {
  return (
    <iframe
      className="file-preview-office"
      title={`${preview.path} 文档预览`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={secureOfficeDocumentHtml(preview.html)}
    />
  );
}
