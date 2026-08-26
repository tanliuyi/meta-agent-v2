import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { protocol } from "electron";
import { PDF_PREVIEW_SCHEME } from "../../shared/pdf-preview-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { resolveProjectFilePath } from "./project-file-path.ts";

export function registerPdfPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PDF_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

type OpenPdfFile = (path: string) => Promise<FileHandle>;

export function handlePdfPreviewRequests(
  projects: ProjectStore,
  openFile: OpenPdfFile = (path) => open(path, "r"),
): void {
  protocol.handle(PDF_PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "project" || url.pathname !== "/document") return notFound();
      const projectId = url.searchParams.get("projectId");
      const path = url.searchParams.get("path");
      if (!projectId || !path || extname(path).toLowerCase() !== ".pdf") return notFound();

      const cwd = await realpath(projects.getCwd(projectId));
      const target = resolveProjectFilePath(cwd, path);
      const canonicalTarget = await realpath(target);
      resolveProjectFilePath(cwd, canonicalTarget);
      if (extname(canonicalTarget).toLowerCase() !== ".pdf") return notFound();

      const expected = await stat(canonicalTarget, { bigint: true });
      const file = await openFile(canonicalTarget);
      let handedOff = false;
      try {
        const actual = await file.stat({ bigint: true });
        if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) return notFound();
        if (actual.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          return new Response("PDF is too large", { status: 413 });
        }

        const size = Number(actual.size);
        const rangeHeader = request.headers.get("range");
        const range = rangeHeader === null ? null : parseByteRange(rangeHeader, size);
        if (range === "unsatisfiable") {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }

        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const headers = new Headers({
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Disposition": "inline",
          "Content-Length": String(Math.max(0, end - start + 1)),
          "Content-Type": "application/pdf",
        });
        if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        const response = new Response(fileBody(file, start, end), { status: range ? 206 : 200, headers });
        handedOff = true;
        return response;
      } finally {
        if (!handedOff) await file.close().catch(() => undefined);
      }
    } catch {
      return notFound();
    }
  });
}

function fileBody(file: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await file.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const length = Math.min(64 * 1024, end - position + 1);
      if (length <= 0) {
        controller.close();
        await close();
        return;
      }
      try {
        const chunk = new Uint8Array(length);
        const { bytesRead } = await file.read(chunk, 0, length, position);
        if (bytesRead === 0) {
          controller.close();
          await close();
          return;
        }
        position += bytesRead;
        controller.enqueue(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
        if (position > end) {
          controller.close();
          await close();
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    cancel: close,
  });
}

function parseByteRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return "unsatisfiable";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
