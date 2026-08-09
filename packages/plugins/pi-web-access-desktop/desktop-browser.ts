import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

const OPEN_BROWSER_TIMEOUT_MS = 15_000;

/** Opens a URL in the current Desktop session's embedded browser through its local RPC host. */
export async function openDesktopBrowser(url: string, options?: ExecOptions): Promise<ExecResult> {
  const validationError = validateUrl(url);
  if (validationError) return failureResult(validationError, false);

  const port = parsePort(process.env.PI_BROWSER_HOST_PORT);
  const token = process.env.PI_BROWSER_TOKEN;
  const sessionToken = process.env.PI_BROWSER_SESSION_TOKEN;
  const projectId = process.env.PI_BROWSER_SESSION_PROJECT_ID;
  const threadId = process.env.PI_BROWSER_SESSION_THREAD_ID;
  if (port === undefined || !token || !sessionToken || !projectId || !threadId) {
    return failureResult("Desktop 内置浏览器宿主未就绪", false);
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeout && options.timeout > 0 ? options.timeout : OPEN_BROWSER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.signal?.aborted) controller.abort();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-browser-token": token,
        "x-desktop-browser-session-token": sessionToken,
        "x-desktop-browser-session-project-id": projectId,
        "x-desktop-browser-session-thread-id": threadId,
      },
      body: JSON.stringify({ method: "openTab", params: { url } }),
      signal: controller.signal,
    });
    const body = (await response.json()) as unknown;
    const error = browserRpcError(body);
    if (!response.ok || error) return failureResult(error ?? `浏览器宿主服务错误（HTTP ${response.status}）`, false);
    return successResult();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failureResult(`无法打开 Desktop 内置浏览器：${message}`, options?.signal?.aborted === true);
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

function validateUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "仅支持 http/https 链接";
  } catch {
    return "无效的浏览器 URL";
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function browserRpcError(value: unknown): string | undefined {
  if (!isRecord(value)) return "浏览器宿主返回了无效响应";
  if (value.ok === false && typeof value.error === "string") return value.error;
  if (value.ok !== true) return "浏览器宿主返回了失败响应";
  const data = value.data;
  if (isRecord(data) && data.ok === false && typeof data.error === "string") return data.error;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function successResult(): ExecResult {
  return { stdout: "", stderr: "", code: 0, killed: false };
}

function failureResult(stderr: string, killed: boolean): ExecResult {
  return { stdout: "", stderr, code: 1, killed };
}
