import { join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol, type Session } from "electron";
import { BROWSER_INTERNAL_SCHEME, parseBrowserInternalPage } from "../../shared/browser-internal-contracts.ts";

const pendingProtocols = new WeakSet<object>();

export function registerBrowserInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: BROWSER_INTERNAL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
      },
    },
  ]);
}

export function handleBrowserInternalPageRequests(
  rendererDirectory: string,
  rendererDevUrl?: string,
  targetSession?: Session,
): void {
  const targetProtocol = targetSession?.protocol ?? protocol;
  if (targetProtocol.isProtocolHandled(BROWSER_INTERNAL_SCHEME) || pendingProtocols.has(targetProtocol)) return;
  pendingProtocols.add(targetProtocol);

  try {
    targetProtocol.handle(BROWSER_INTERNAL_SCHEME, (request) => {
      const url = new URL(request.url);
      if (parseBrowserInternalPage(`${url.protocol}//${url.hostname}`) === null) {
        return new Response("Not found", { status: 404 });
      }

      let requestedPath: string;
      try {
        requestedPath = url.pathname === "/" ? "browser-internal.html" : decodeURIComponent(url.pathname.slice(1));
      } catch {
        return new Response("Not found", { status: 404 });
      }
      if (rendererDevUrl) {
        // Vite 开发入口还会请求 /src、/@vite 和依赖预构建资源。通过 pathname
        // 赋值固定在 renderer dev origin，避免编码路径被解释为跨站 URL。
        const target = new URL(rendererDevUrl);
        target.pathname = `/${requestedPath.replace(/^\/+/, "")}`;
        target.search = url.search;
        return net.fetch(target.toString());
      }

      if (requestedPath !== "browser-internal.html" && !requestedPath.startsWith("assets/")) {
        return new Response("Not found", { status: 404 });
      }

      const root = normalize(rendererDirectory);
      const resourcePath = normalize(join(root, requestedPath));
      const resourceRelativePath = relative(root, resourcePath);
      if (resourceRelativePath.startsWith("..") || resourceRelativePath.includes(":")) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(resourcePath).toString());
    });
  } finally {
    pendingProtocols.delete(targetProtocol);
  }
}
