import type { OfficeDocumentPreview as OfficeDocumentPreviewData } from "../../../../../shared/contracts.ts";

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
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${meta}`);
  }
  if (/<html(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/iu, (root) => `${root}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export function OfficeDocumentPreview({ preview }: { preview: OfficeDocumentPreviewData }) {
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
