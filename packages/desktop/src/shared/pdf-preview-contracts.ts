export const PDF_PREVIEW_SCHEME = "meta-agent-pdf";

/** 构造仅由 Desktop 主进程解析的 Project PDF 预览 URL。 */
export function pdfPreviewUrl(projectId: string, path: string): string {
  const url = new URL(`${PDF_PREVIEW_SCHEME}://project/document`);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", path);
  return url.href;
}
