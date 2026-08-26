import type { FileHandle } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handler: undefined as ((request: Request) => Promise<Response>) | undefined,
  handle: vi.fn((_scheme: string, handler: (request: Request) => Promise<Response>) => {
    electron.handler = handler;
  }),
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    handle: electron.handle,
    registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged,
  },
}));

import { handlePdfPreviewRequests, registerPdfPreviewScheme } from "../src/main/files/pdf-preview-protocol.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";
import { PdfDocumentPreview } from "../src/renderer/src/components/panel/files/pdf-document-preview.tsx";
import { pdfPreviewUrl } from "../src/shared/pdf-preview-contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  electron.handler = undefined;
  electron.handle.mockClear();
  electron.registerSchemesAsPrivileged.mockClear();
});

describe("PDF preview", () => {
  it("注册支持流式响应的安全标准 scheme", () => {
    registerPdfPreviewScheme();

    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "meta-agent-pdf",
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
      },
    ]);
  });

  it("仅从 Project 内流式提供 PDF，并固定响应类型", async () => {
    const { project, store, root } = await createProject();
    await writeFile(join(project.cwd, "report.pdf"), "%PDF-1.7");
    await writeFile(join(root, "outside.pdf"), "%PDF-1.7");
    handlePdfPreviewRequests(store);
    if (!electron.handler) throw new Error("PDF preview protocol handler was not registered");

    const response = await electron.handler(new Request(pdfPreviewUrl(project.id, "report.pdf")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("8");
    expect(await response.text()).toBe("%PDF-1.7");

    const escaped = await electron.handler(new Request(pdfPreviewUrl(project.id, "../outside.pdf")));
    expect(escaped.status).toBe(404);
  });

  it("支持单区间 Range 请求，并拒绝不可满足的区间", async () => {
    const { project, store } = await createProject();
    await writeFile(join(project.cwd, "report.pdf"), "%PDF-1.7");
    handlePdfPreviewRequests(store);
    if (!electron.handler) throw new Error("PDF preview protocol handler was not registered");

    const url = pdfPreviewUrl(project.id, "report.pdf");
    const partial = await electron.handler(new Request(url, { headers: { Range: "bytes=0-3" } }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-3/8");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(await partial.text()).toBe("%PDF");

    const unsatisfiable = await electron.handler(new Request(url, { headers: { Range: "bytes=20-30" } }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */8");
  });

  it("打开后读取文件状态失败时关闭句柄", async () => {
    const { project, store } = await createProject();
    await writeFile(join(project.cwd, "report.pdf"), "%PDF-1.7");
    const close = vi.fn(async () => undefined);
    const file = {
      stat: vi.fn(async () => {
        throw new Error("fstat failed");
      }),
      close,
    } as unknown as FileHandle;
    handlePdfPreviewRequests(
      store,
      vi.fn(async () => file),
    );
    if (!electron.handler) throw new Error("PDF preview protocol handler was not registered");

    const response = await electron.handler(new Request(pdfPreviewUrl(project.id, "report.pdf")));

    expect(response.status).toBe(404);
    expect(close).toHaveBeenCalledOnce();
  });

  it("用无 sandbox iframe 承载 Electron 内置查看器", () => {
    const url = pdfPreviewUrl("project-id", "docs/report.pdf");
    const markup = renderToStaticMarkup(<PdfDocumentPreview preview={{ path: "docs/report.pdf", url }} />);

    expect(markup).toContain('class="file-preview-pdf"');
    expect(markup).toContain(`src="${url.replaceAll("&", "&amp;")}"`);
    expect(markup).not.toContain("sandbox=");
  });
});

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-pdf-preview-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { project, root, store };
}
