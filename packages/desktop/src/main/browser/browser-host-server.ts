/**
 * 本地 HTTP RPC：供 sidecar 内的 pi-browser extension 调用 main 进程的
 * BrowserManager。
 *
 * 理由：pi extension 运行在 Electron-as-Node sidecar 进程，无法直接引用
 * main 进程对象。main 在 127.0.0.1 随机端口起一个最小 HTTP 服务，token
 * 经 worker 环境变量（PI_BROWSER_HOST_PORT / PI_BROWSER_TOKEN）注入
 * sidecar，extension 用 fetch 调用。
 *
 * 会话隔离：每个请求必须携带会话身份头（PI_BROWSER_SESSION_PROJECT_ID /
 * PI_BROWSER_SESSION_THREAD_ID 注入，BrowserClient 逐请求发送）。RPC 只接受
 * BrowserManager 中真实注册过的会话（由 ThreadWorkerBinding 受控注册），
 * 未知身份一律 403 fail-closed。
 *
 * 安全：仅监听 loopback；请求必须带 x-desktop-browser-token（随机 32 字节
 * hex）；方法白名单固定；body 上限 1MB；所有错误转 { ok:false, error }。
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BrowserAction, BrowserActionTarget, BrowserSessionIdentity } from "../../shared/browser-contracts.ts";
import { browserSessionKey } from "../../shared/browser-contracts.ts";
import type { BrowserManager } from "./browser-manager.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface BrowserHostServer {
  /** server 就绪后可读取；未就绪返回 null。 */
  getEndpoint(): { port: number; token: string } | null;
  dispose(): Promise<void>;
}

interface RpcRequest {
  method: string;
  params?: unknown;
}

export function createBrowserHostServer(
  manager: BrowserManager,
  options: { log?: (text: string) => void } = {},
): Promise<BrowserHostServer> {
  const token = randomBytes(32).toString("hex");
  let port = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response, manager, token, options.log);
  });

  return new Promise<BrowserHostServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("浏览器宿主服务启动失败：无法确定端口"));
        return;
      }
      port = address.port;
      resolve({
        getEndpoint: () => ({ port, token }),
        dispose: () => closeServer(server),
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manager: BrowserManager,
  token: string,
  log: ((text: string) => void) | undefined,
): Promise<void> {
  try {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/healthz") {
      writeJson(response, 200, { ok: true, health: "ok" });
      return;
    }
    if (request.method !== "POST" || url !== "/rpc") {
      writeJson(response, 404, { ok: false, error: "Not Found" });
      return;
    }
    const headerToken = request.headers["x-desktop-browser-token"];
    if (headerToken !== token) {
      writeJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const identity = readSessionIdentity(request);
    const capability = readSessionCapability(request);
    if (identity === null || capability === null) {
      writeJson(response, 403, { ok: false, error: "缺少浏览器会话身份或 capability" });
      return;
    }
    const capabilityIdentity = manager.resolveSessionCapability(capability);
    if (capabilityIdentity === null || browserSessionKey(capabilityIdentity) !== browserSessionKey(identity)) {
      writeJson(response, 403, { ok: false, error: "浏览器会话 capability 无效" });
      return;
    }
    if (!manager.isKnownSession(identity)) {
      writeJson(response, 403, { ok: false, error: "未知的浏览器会话身份" });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      // 暂停继续接收（避免内存膨胀），先回 413 再结束连接。
      request.pause();
      writeJson(response, 413, { ok: false, error: "请求体过大（超过 1MB）" });
      return;
    }
    const rpc = parseRpc(body);
    if (rpc === null) {
      writeJson(response, 400, { ok: false, error: "JSON 解析失败" });
      return;
    }
    // 客户端断开（工具 abort）时取消 openTab 等待：不执行动作、不留 pending 孤儿。
    const controller = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) controller.abort();
    };
    // request.close 可能在请求体读取完成后已经触发；aborted 和 response.close
    // 覆盖客户端在服务端进入长时间 dispatch 后关闭连接的情况。
    request.once("aborted", onClose);
    response.once("close", onClose);
    let result: unknown;
    try {
      result = await dispatch(rpc, manager, identity, controller.signal);
    } finally {
      request.off("aborted", onClose);
      response.off("close", onClose);
    }
    if (!response.writableEnded) writeJson(response, 200, result);
  } catch (error) {
    log?.(`browser host rpc error: ${messageOf(error)}`);
    writeJson(response, 500, { ok: false, error: messageOf(error) });
  }
}

async function dispatch(
  rpc: RpcRequest,
  manager: BrowserManager,
  identity: BrowserSessionIdentity,
  signal: AbortSignal,
): Promise<unknown> {
  const method = rpc.method;
  const params = rpc.params as Record<string, unknown> | undefined;
  switch (method) {
    case "tabsList":
      return { ok: true, data: manager.tabsList(identity) };
    case "activeTab":
      return { ok: true, data: manager.activeTab(identity) };
    case "navigate": {
      requireParams(params, ["tabId", "url"]);
      const safe = params as Record<string, unknown>;
      return {
        ok: true,
        data: await manager.navigate(identity, Number(safe.tabId), String(safe.url), "agent", signal),
      };
    }
    case "historyTarget": {
      requireParams(params, ["tabId", "direction"]);
      const safe = params as Record<string, unknown>;
      if (safe.direction !== "back" && safe.direction !== "forward") {
        return { ok: false, error: "direction 参数非法" };
      }
      return {
        ok: true,
        data: manager.navigationTarget(identity, Number(safe.tabId), safe.direction),
      };
    }
    case "goBack": {
      requireParams(params, ["tabId"]);
      const safe = params as Record<string, unknown>;
      return {
        ok: true,
        data: await manager.goBack(
          identity,
          Number(safe.tabId),
          "agent",
          typeof safe.navigationApprovalUrl === "string" ? safe.navigationApprovalUrl : undefined,
          signal,
        ),
      };
    }
    case "goForward": {
      requireParams(params, ["tabId"]);
      const safe = params as Record<string, unknown>;
      return {
        ok: true,
        data: await manager.goForward(
          identity,
          Number(safe.tabId),
          "agent",
          typeof safe.navigationApprovalUrl === "string" ? safe.navigationApprovalUrl : undefined,
          signal,
        ),
      };
    }
    case "reload": {
      requireParams(params, ["tabId"]);
      return {
        ok: true,
        data: await manager.reload(identity, Number((params as Record<string, unknown>).tabId), "agent", signal),
      };
    }
    case "snapshot": {
      requireParams(params, ["tabId"]);
      const safe = params as Record<string, unknown>;
      return {
        ok: true,
        data: await manager.snapshot(
          identity,
          Number(safe.tabId),
          {
            withScreenshot: safe.withScreenshot === true,
          },
          "agent",
          signal,
        ),
      };
    }
    case "inspectElement": {
      requireParams(params, ["tabId", "elementIndex"]);
      const safe = params as Record<string, unknown>;
      if (typeof safe.elementIndex !== "number" || !Number.isInteger(safe.elementIndex)) {
        return { ok: false, error: "elementIndex 参数非法" };
      }
      return { ok: true, data: manager.inspectElement(identity, Number(safe.tabId), safe.elementIndex) };
    }
    case "action": {
      requireParams(params, ["tabId", "action"]);
      const safe = params as Record<string, unknown>;
      const action = parseBrowserAction(safe.action);
      if (action === null) {
        return { ok: false, error: "action 参数非法：需为 { type: click|type|scroll, ... } 形状" };
      }
      return { ok: true, data: await manager.action(identity, Number(safe.tabId), action, "agent", signal) };
    }
    case "openTab": {
      requireParams(params, ["url"]);
      const safe = params as Record<string, unknown>;
      return { ok: true, data: await manager.openTab(identity, String(safe.url), "agent", signal) };
    }
    case "screenshot": {
      requireParams(params, ["tabId"]);
      const safe = params as Record<string, unknown>;
      return { ok: true, data: await manager.screenshot(identity, Number(safe.tabId), "agent", signal) };
    }
    case "clearData":
      return { ok: true, data: await manager.clearSessionData(identity, signal) };
    case "history":
      return { ok: true, data: manager.browserHistory(identity) };
    case "getSettings":
      return { ok: true, data: await manager.getSettingsSnapshot() };
    default:
      throw new Error(`不支持的方法: ${method}`);
  }
}

function readSessionCapability(request: IncomingMessage): string | null {
  const capability = request.headers["x-desktop-browser-session-token"];
  return typeof capability === "string" && capability.length > 0 ? capability : null;
}

function readSessionIdentity(request: IncomingMessage): BrowserSessionIdentity | null {
  const projectId = request.headers["x-desktop-browser-session-project-id"];
  const threadId = request.headers["x-desktop-browser-session-thread-id"];
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  return { projectId, threadId };
}

function requireParams(params: Record<string, unknown> | undefined, keys: string[]): void {
  if (!params || typeof params !== "object") throw new Error("缺少请求参数");
  for (const key of keys) {
    if (params[key] === undefined) throw new Error(`缺少参数: ${key}`);
  }
}

function parseRpc(body: string): RpcRequest | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.method !== "string") return null;
    return { method: candidate.method, params: candidate.params };
  } catch {
    return null;
  }
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => {
      resolve(null);
    });
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 空闲连接不阻塞关闭：主动关闭未结束的连接。
    server.closeAllConnections?.();
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 运行时校验 RPC action 参数（避免强转后非法动作静默通过）。 */
function parseBrowserAction(value: unknown): BrowserAction | null {
  if (typeof value !== "object" || value === null) return null;
  const action = value as Record<string, unknown>;
  const target = parseBrowserActionTarget(action.target);
  if (action.target !== undefined && target === null) return null;
  if (action.type === "click") {
    if (typeof action.elementIndex !== "number" || !Number.isInteger(action.elementIndex) || action.elementIndex < 1) {
      return null;
    }
    return {
      type: "click",
      elementIndex: action.elementIndex,
      ...(typeof action.navigationApprovalUrl === "string"
        ? { navigationApprovalUrl: action.navigationApprovalUrl }
        : {}),
      ...(target ? { target } : {}),
    };
  }
  if (action.type === "type") {
    if (
      typeof action.elementIndex !== "number" ||
      !Number.isInteger(action.elementIndex) ||
      action.elementIndex < 1 ||
      typeof action.text !== "string"
    ) {
      return null;
    }
    return {
      type: "type",
      elementIndex: action.elementIndex,
      text: action.text,
      submit: action.submit === true,
      ...(target ? { target } : {}),
    };
  }
  if (action.type === "scroll") {
    const direction = action.direction;
    if (direction !== "up" && direction !== "down" && direction !== "top" && direction !== "bottom") return null;
    const amount = action.amount;
    if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) return null;
    if (action.expectedUrl !== undefined && typeof action.expectedUrl !== "string") return null;
    return {
      type: "scroll",
      direction,
      amount: amount === undefined ? undefined : amount,
      ...(typeof action.expectedUrl === "string" ? { expectedUrl: action.expectedUrl } : {}),
    };
  }
  return null;
}

function parseBrowserActionTarget(value: unknown): BrowserActionTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const target = value as Record<string, unknown>;
  if (
    typeof target.pageUrl !== "string" ||
    typeof target.role !== "string" ||
    typeof target.tag !== "string" ||
    typeof target.name !== "string"
  ) {
    return null;
  }
  if (target.selector !== undefined && typeof target.selector !== "string") return null;
  const attrs = target.attrs;
  if (attrs !== undefined && (typeof attrs !== "object" || attrs === null || Array.isArray(attrs))) return null;
  return {
    pageUrl: target.pageUrl,
    role: target.role,
    tag: target.tag,
    name: target.name,
    ...(typeof target.selector === "string" ? { selector: target.selector } : {}),
    ...(attrs !== undefined ? { attrs: attrs as BrowserActionTarget["attrs"] } : {}),
  };
}
