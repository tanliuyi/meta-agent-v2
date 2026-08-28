import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BrowserSessionIdentity } from "../../shared/browser-contracts.ts";
import { browserSessionKey } from "../../shared/browser-contracts.ts";
import type { OfficeDocumentHostRequest } from "../../shared/office-document-contracts.ts";
import type { NativeOfficeDocumentService } from "../files/native-office-document-service.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface OfficeDocumentHostServer {
  getEndpoint(): { port: number; token: string } | null;
  dispose(): Promise<void>;
}

export interface OfficeDocumentHostServerOptions {
  resolveSessionCapability(token: string): BrowserSessionIdentity | null;
  log?(text: string): void;
}

export function createOfficeDocumentHostServer(
  documents: NativeOfficeDocumentService,
  options: OfficeDocumentHostServerOptions,
): Promise<OfficeDocumentHostServer> {
  const token = randomBytes(32).toString("hex");
  let port = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response, documents, options, token);
  });
  return new Promise<OfficeDocumentHostServer>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectServer(new Error("Office 文档宿主服务启动失败：无法确定端口"));
        return;
      }
      port = address.port;
      resolveServer({
        getEndpoint: () => ({ port, token }),
        dispose: () => closeServer(server),
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  documents: NativeOfficeDocumentService,
  options: OfficeDocumentHostServerOptions,
  token: string,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { ok: true, health: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/rpc") {
      writeJson(response, 404, { ok: false, error: "Not Found" });
      return;
    }
    if (request.headers["x-desktop-office-token"] !== token) {
      writeJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const identity = readIdentity(request);
    const capability = readHeader(request, "x-desktop-office-session-token");
    if (!identity || !capability) {
      writeJson(response, 403, { ok: false, error: "缺少 Office 文档会话身份或 capability" });
      return;
    }
    const capabilityIdentity = options.resolveSessionCapability(capability);
    if (!capabilityIdentity || browserSessionKey(capabilityIdentity) !== browserSessionKey(identity)) {
      writeJson(response, 403, { ok: false, error: "Office 文档会话 capability 无效" });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      request.pause();
      writeJson(response, 413, { ok: false, error: "请求体过大（超过 1MB）" });
      return;
    }
    const hostRequest = parseHostRequest(body);
    if (!hostRequest) {
      writeJson(response, 400, { ok: false, error: "Office 文档请求格式无效" });
      return;
    }
    if (hostRequest.projectId !== identity.projectId) {
      writeJson(response, 403, { ok: false, error: "Office 文档项目身份不匹配" });
      return;
    }
    let data: unknown;
    if (hostRequest.type === "office-document.list") {
      data = documents.listForAgent(identity.projectId);
    } else if (hostRequest.type === "office-document.inspect") {
      data = await documents.inspectForAgent(identity.projectId, hostRequest.documentId, hostRequest.query);
    } else {
      data = await documents.planForAgent(identity.projectId, hostRequest.input);
    }
    writeJson(response, 200, { ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`office document host rpc error: ${message}`);
    writeJson(response, 500, { ok: false, error: message });
  }
}

function parseHostRequest(body: string): OfficeDocumentHostRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const request = parsed as Record<string, unknown>;
  if (request.type === "office-document.list") {
    if (typeof request.projectId !== "string") return null;
    return request as unknown as Extract<OfficeDocumentHostRequest, { type: "office-document.list" }>;
  }
  if (request.type === "office-document.inspect") {
    if (typeof request.projectId !== "string" || typeof request.documentId !== "string") return null;
    if (typeof request.query !== "object" || request.query === null || Array.isArray(request.query)) return null;
    return request as unknown as Extract<OfficeDocumentHostRequest, { type: "office-document.inspect" }>;
  }
  if (request.type === "office-document.plan") {
    if (typeof request.projectId !== "string") return null;
    if (typeof request.input !== "object" || request.input === null || Array.isArray(request.input)) return null;
    return request as unknown as Extract<OfficeDocumentHostRequest, { type: "office-document.plan" }>;
  }
  return null;
}

function readIdentity(request: IncomingMessage): BrowserSessionIdentity | null {
  const projectId = readHeader(request, "x-desktop-office-session-project-id");
  const threadId = readHeader(request, "x-desktop-office-session-thread-id");
  return projectId && threadId ? { projectId, threadId } : null;
}

function readHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        resolveBody(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolveBody(Buffer.concat(chunks, total).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectBody(error);
      }
    });
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
    server.closeAllConnections();
  });
}
