import { join, normalize, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { BROWSER_INTERNAL_SCHEME, parseBrowserInternalPage } from "../../shared/browser-internal-contracts.ts";

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

export function handleBrowserInternalPageRequests(rendererDirectory: string, rendererDevUrl?: string): void {
  protocol.handle(BROWSER_INTERNAL_SCHEME, (request) => {
    const url = new URL(request.url);
    if (parseBrowserInternalPage(`${url.protocol}//${url.hostname}`) === null) {
      return new Response("Not found", { status: 404 });
    }

    const requestedPath = url.pathname === "/" ? "browser-internal.html" : decodeURIComponent(url.pathname.slice(1));
    if (rendererDevUrl) {
      // Vite 开发入口还会请求 /src、/@vite 和依赖预构建资源；仅 browser:// 已知 host
      // 能进入这里，因此可代理该入口产生的任意开发资源路径。
      return net.fetch(new URL(requestedPath, `${rendererDevUrl.replace(/\/$/, "")}/`).toString());
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
}
