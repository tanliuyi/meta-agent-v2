import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import officeDocumentExtension from "../src/sidecar/pi-office-document-extension.ts";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

const tools = new Map<string, RegisteredTool>();

beforeEach(() => {
  tools.clear();
  officeDocumentExtension({
    registerTool(tool: unknown) {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    },
  } as unknown as Parameters<typeof officeDocumentExtension>[0]);
  vi.stubEnv("PI_OFFICE_HOST_PORT", "43123");
  vi.stubEnv("PI_OFFICE_TOKEN", "global-token");
  vi.stubEnv("PI_BROWSER_SESSION_TOKEN", "session-token");
  vi.stubEnv("PI_BROWSER_SESSION_PROJECT_ID", "project-a");
  vi.stubEnv("PI_BROWSER_SESSION_THREAD_ID", "thread-a");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pi-office-document extension", () => {
  it("检查请求携带全局 token 与会话身份", async () => {
    const inspection = { documentId: "document-a", revision: 1, result: { mode: "sheets", sheets: [] } };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: inspection }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = tools.get("office_document_inspect");
    if (!tool) throw new Error("inspect tool was not registered");

    const result = await tool.execute("call-a", { documentId: "document-a", query: { mode: "sheets" } });

    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual(inspection);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43123/rpc");
    expect(init?.headers).toMatchObject({
      "x-desktop-office-token": "global-token",
      "x-desktop-office-session-token": "session-token",
      "x-desktop-office-session-project-id": "project-a",
      "x-desktop-office-session-thread-id": "thread-a",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "office-document.inspect",
      projectId: "project-a",
      documentId: "document-a",
      query: { mode: "sheets" },
    });
  });

  it("未提供 documentId 时列出当前 Project 已打开文档", async () => {
    const handles = [{ documentId: "document-a", path: "reports/a.docx", format: "docx", revision: 1 }];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: handles }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = tools.get("office_document_inspect");
    if (!tool) throw new Error("inspect tool was not registered");

    const result = await tool.execute("call-list", {});

    expect(result.details).toEqual(handles);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ type: "office-document.list", projectId: "project-a" });
  });

  it("拒绝在同一计划混合 DOCX 与 XLSX operation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = tools.get("office_document_plan");
    if (!tool) throw new Error("plan tool was not registered");
    const digest = "a".repeat(64);

    await expect(
      tool.execute("call-b", {
        documentId: "document-a",
        operations: [
          {
            type: "set_cell_value",
            target: { sheetId: "sheet-a", cellId: "cell-a", address: "A1" },
            precondition: { documentRevision: 1, expectedValue: "1", expectedValueSha256: digest },
            replacement: "2",
          },
          {
            type: "replace_text_run",
            target: { part: "document", paragraphId: "paragraph-a", runId: "run-a" },
            precondition: { documentRevision: 1, expectedText: "before", expectedTextSha256: digest },
            replacement: "after",
          },
        ],
      }),
    ).rejects.toThrow("DOCX 与 XLSX operation 不能混合在同一计划中");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺少宿主环境变量时 fail-closed", async () => {
    vi.stubEnv("PI_OFFICE_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = tools.get("office_document_inspect");
    if (!tool) throw new Error("inspect tool was not registered");

    await expect(tool.execute("call-c", { documentId: "document-a", query: { mode: "sheets" } })).rejects.toThrow(
      "缺少 PI_OFFICE_TOKEN",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
