import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeOfficeDocumentService } from "../src/main/files/native-office-document-service.ts";
import type { OfficeDocumentHostServer } from "../src/main/office/office-document-host-server.ts";
import { createOfficeDocumentHostServer } from "../src/main/office/office-document-host-server.ts";

const SESSION = { projectId: "project-a", threadId: "thread-a" };
const CAPABILITY = "capability-a";

interface StubDocuments {
  listForAgent: ReturnType<typeof vi.fn>;
  inspectForAgent: ReturnType<typeof vi.fn>;
  planForAgent: ReturnType<typeof vi.fn>;
}

let server: OfficeDocumentHostServer | null = null;

function createDocuments(): StubDocuments {
  return {
    listForAgent: vi.fn(() => [{ documentId: "document-a", path: "reports/a.docx", format: "docx", revision: 1 }]),
    inspectForAgent: vi.fn(async () => ({
      documentId: "document-a",
      revision: 1,
      result: { mode: "sheets", sheets: [] },
    })),
    planForAgent: vi.fn(async () => ({ planId: "plan-a", documentId: "document-a" })),
  };
}

async function postRpc(
  endpoint: { port: number; token: string },
  body: unknown,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-desktop-office-token": endpoint.token,
      "x-desktop-office-session-token": CAPABILITY,
      "x-desktop-office-session-project-id": SESSION.projectId,
      "x-desktop-office-session-thread-id": SESSION.threadId,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await server?.dispose();
  server = null;
});

describe("OfficeDocumentHostServer", () => {
  it("只允许有效 capability 对应的会话检查文档", async () => {
    const documents = createDocuments();
    server = await createOfficeDocumentHostServer(documents as unknown as NativeOfficeDocumentService, {
      resolveSessionCapability: (token) => (token === CAPABILITY ? SESSION : null),
    });
    const endpoint = server.getEndpoint();
    expect(endpoint).not.toBeNull();
    if (!endpoint) throw new Error("Office host endpoint unavailable");

    const response = await postRpc(endpoint, {
      type: "office-document.inspect",
      projectId: SESSION.projectId,
      documentId: "document-a",
      query: { mode: "sheets" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { documentId: "document-a", revision: 1 } });
    expect(documents.inspectForAgent).toHaveBeenCalledWith(SESSION.projectId, "document-a", { mode: "sheets" });
  });

  it("仅列出 capability 所属 Project 的已打开文档", async () => {
    const documents = createDocuments();
    server = await createOfficeDocumentHostServer(documents as unknown as NativeOfficeDocumentService, {
      resolveSessionCapability: () => SESSION,
    });
    const endpoint = server.getEndpoint();
    if (!endpoint) throw new Error("Office host endpoint unavailable");

    const response = await postRpc(endpoint, { type: "office-document.list", projectId: SESSION.projectId });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: [{ documentId: "document-a", path: "reports/a.docx", format: "docx", revision: 1 }],
    });
    expect(documents.listForAgent).toHaveBeenCalledWith(SESSION.projectId);
  });

  it("拒绝无效全局 token、capability 和跨项目请求", async () => {
    const documents = createDocuments();
    server = await createOfficeDocumentHostServer(documents as unknown as NativeOfficeDocumentService, {
      resolveSessionCapability: (token) => (token === CAPABILITY ? SESSION : null),
    });
    const endpoint = server.getEndpoint();
    if (!endpoint) throw new Error("Office host endpoint unavailable");
    const request = {
      type: "office-document.inspect",
      projectId: SESSION.projectId,
      documentId: "document-a",
      query: { mode: "sheets" },
    };

    expect((await postRpc(endpoint, request, { "x-desktop-office-token": "wrong" })).status).toBe(401);
    expect((await postRpc(endpoint, request, { "x-desktop-office-session-token": "wrong" })).status).toBe(403);
    expect((await postRpc(endpoint, { ...request, projectId: "project-b" })).status).toBe(403);
    expect(documents.inspectForAgent).not.toHaveBeenCalled();
  });

  it("仅接受 inspect 与 plan 请求且宿主不暴露 commit", async () => {
    const documents = createDocuments();
    server = await createOfficeDocumentHostServer(documents as unknown as NativeOfficeDocumentService, {
      resolveSessionCapability: () => SESSION,
    });
    const endpoint = server.getEndpoint();
    if (!endpoint) throw new Error("Office host endpoint unavailable");

    const invalid = await postRpc(endpoint, { type: "office-document.commit", projectId: SESSION.projectId });
    expect(invalid.status).toBe(400);

    const plan = await postRpc(endpoint, {
      type: "office-document.plan",
      projectId: SESSION.projectId,
      input: {
        documentId: "document-a",
        envelope: { protocolVersion: 1, operations: [] },
      },
    });
    expect(plan.status).toBe(200);
    expect(documents.planForAgent).toHaveBeenCalledOnce();
  });
});
