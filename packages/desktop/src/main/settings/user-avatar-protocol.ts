import { lstat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { MARKDOWN_IMAGE_SCHEME } from "../../shared/markdown-image-contracts.ts";
import { USER_AVATAR_SCHEME } from "../../shared/settings-config-contracts.ts";

const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MARKDOWN_IMAGE_EXTENSIONS = new Set([...AVATAR_EXTENSIONS, ".avif", ".bmp", ".gif"]);

export function registerLocalImageSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: USER_AVATAR_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    {
      scheme: MARKDOWN_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function handleLocalImageRequests(): void {
  protocol.handle(USER_AVATAR_SCHEME, async (request) => {
    const url = new URL(request.url);
    const path = url.hostname === "local" && url.pathname === "/image" ? url.searchParams.get("path") : null;
    return serveLocalImage(path, AVATAR_EXTENSIONS);
  });
  protocol.handle(MARKDOWN_IMAGE_SCHEME, async (request) => {
    const url = new URL(request.url);
    const source = url.hostname === "local" && url.pathname === "/image" ? url.searchParams.get("source") : null;
    return serveMarkdownImage(source);
  });
}

async function serveMarkdownImage(source: string | null): Promise<Response> {
  const localPath = localPathFromSource(source);
  if (localPath) return serveLocalImage(localPath, MARKDOWN_IMAGE_EXTENSIONS);
  if (!source) return notFound();

  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return notFound();
    const response = await net.fetch(url.href);
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/")) return notFound();
    return responseWithCors(response);
  } catch {
    return notFound();
  }
}

function localPathFromSource(source: string | null): string | null {
  if (!source) return null;
  if (isAbsolute(source)) return source;
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

async function serveLocalImage(path: string | null, supportedExtensions: ReadonlySet<string>): Promise<Response> {
  if (!path || !isAbsolute(path) || !supportedExtensions.has(extname(path).toLowerCase())) return notFound();
  try {
    const info = await lstat(path);
    if (!info.isFile()) return notFound();
    return responseWithCors(await net.fetch(pathToFileURL(path).href));
  } catch {
    return notFound();
  }
}

function responseWithCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
