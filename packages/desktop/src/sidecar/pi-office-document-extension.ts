import { createHash } from "node:crypto";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DocumentOperation, SetCellValueOperation } from "@earendil-works/pi-office-engine";
import { Type } from "typebox";
import type {
  OfficeDocumentHandle,
  OfficeDocumentHostRequest,
  OfficeDocumentInspection,
  OfficeDocumentPlan,
  PlanOfficeDocumentInput,
} from "../shared/office-document-contracts.ts";

const inspectionParts = Type.Optional(
  Type.Array(
    Type.Union([Type.Literal("document"), Type.Literal("header"), Type.Literal("footer"), Type.Literal("comments")]),
    { minItems: 1, maxItems: 4, uniqueItems: true },
  ),
);
const inspectionQuery = Type.Union([
  Type.Object({ mode: Type.Literal("sheets"), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
  Type.Object({
    mode: Type.Literal("cells"),
    sheetId: Type.String({ minLength: 1 }),
    range: Type.Optional(Type.String({ minLength: 3, maxLength: 32 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  Type.Object({
    mode: Type.Literal("search-cells"),
    text: Type.String({ minLength: 1, maxLength: 128 }),
    sheetId: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  Type.Object({
    mode: Type.Literal("outline"),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    parts: inspectionParts,
  }),
  Type.Object({
    mode: Type.Literal("paragraphs"),
    paragraphIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
    parts: inspectionParts,
  }),
  Type.Object({
    mode: Type.Literal("search"),
    text: Type.String({ minLength: 1, maxLength: 128 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    parts: inspectionParts,
  }),
]);
const setCellValueOperation = Type.Object({
  type: Type.Literal("set_cell_value"),
  target: Type.Object({
    sheetId: Type.String({ minLength: 1 }),
    cellId: Type.String({ minLength: 1 }),
    address: Type.String({ pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$" }),
  }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 1 }),
    expectedValue: Type.String(),
    expectedValueSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
  replacement: Type.String(),
});
const replaceTextRunOperation = Type.Object({
  type: Type.Literal("replace_text_run"),
  target: Type.Object({
    part: Type.Literal("document"),
    paragraphId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
  }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 0 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
  replacement: Type.String(),
});
const replaceRelatedTextRunOperation = Type.Object({
  type: Type.Literal("replace_related_text_run"),
  target: Type.Object({
    part: Type.Union([Type.Literal("header"), Type.Literal("footer")]),
    relatedPartId: Type.String({ minLength: 1 }),
    paragraphId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
  }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 1 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
  replacement: Type.String(),
});
const replaceCommentTextRunOperation = Type.Object({
  type: Type.Literal("replace_comment_text_run"),
  target: Type.Object({
    part: Type.Literal("comments"),
    commentId: Type.String({ minLength: 1 }),
    paragraphId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
  }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 1 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
  replacement: Type.String(),
});
const replaceTextRangeOperation = Type.Object({
  type: Type.Literal("replace_text_range"),
  target: Type.Object({
    part: Type.Literal("document"),
    paragraphId: Type.String({ minLength: 1 }),
    start: Type.Object({ runId: Type.String({ minLength: 1 }), offset: Type.Integer({ minimum: 0 }) }),
    end: Type.Object({ runId: Type.String({ minLength: 1 }), offset: Type.Integer({ minimum: 0 }) }),
  }),
  precondition: Type.Object({ documentRevision: Type.Integer({ minimum: 0 }), expectedText: Type.String() }),
  replacement: Type.String(),
});
const insertParagraphAfterOperation = Type.Object({
  type: Type.Literal("insert_paragraph_after"),
  target: Type.Object({ part: Type.Literal("document"), paragraphId: Type.String({ minLength: 1 }) }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 0 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
  replacement: Type.String(),
});
const deleteParagraphOperation = Type.Object({
  type: Type.Literal("delete_paragraph"),
  target: Type.Object({ part: Type.Literal("document"), paragraphId: Type.String({ minLength: 1 }) }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 0 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
  }),
});
const setTextRunStyleOperation = Type.Object({
  type: Type.Literal("set_text_run_style"),
  target: Type.Object({
    part: Type.Literal("document"),
    paragraphId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
  }),
  precondition: Type.Object({
    documentRevision: Type.Integer({ minimum: 0 }),
    expectedText: Type.String(),
    expectedTextSha256: Type.String({ minLength: 64, maxLength: 64 }),
    expectedProperties: Type.Object({
      bold: Type.Boolean(),
      italic: Type.Boolean(),
      styleId: Type.Optional(Type.String({ minLength: 1 })),
    }),
  }),
  replacement: Type.Union([
    Type.Object({ bold: Type.Boolean() }),
    Type.Object({ italic: Type.Boolean() }),
    Type.Object({ bold: Type.Boolean(), italic: Type.Boolean() }),
  ]),
});

export default function officeDocumentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "office_document_inspect",
    label: "检查 Office 文档",
    description:
      "检查用户已在 Desktop 文件面板打开的 DOCX 或 XLSX 文档。省略 documentId 可先列出当前 Project 的可用文档；指定后返回有界结构化内容，不返回原始 XML。DOCX 先取 outline；XLSX 先取 sheets，再按 sheet/range 读取 cells。",
    promptSnippet: "检查 Desktop 中已打开的 DOCX 或 XLSX 文档结构和内容",
    parameters: Type.Object({
      documentId: Type.Optional(
        Type.String({ minLength: 1, description: "Desktop 原生 Office 预览中的 documentId；省略则列出可用文档" }),
      ),
      query: Type.Optional(inspectionQuery),
    }),
    async execute(_toolCallId, params) {
      const projectId = requireEnvironment("PI_BROWSER_SESSION_PROJECT_ID");
      if (!params.documentId) {
        return jsonResult((await requestHost({ type: "office-document.list", projectId })) as OfficeDocumentHandle[]);
      }
      if (!params.query) throw new Error("指定 documentId 时必须提供 query");
      return jsonResult(
        (await requestHost({
          type: "office-document.inspect",
          projectId,
          documentId: params.documentId,
          query: params.query,
        })) as OfficeDocumentInspection,
      );
    },
  });
  pi.registerTool({
    name: "office_document_plan",
    label: "规划 Office 文档修改",
    description:
      "为用户已打开的 DOCX 或 XLSX 文档创建结构化修改计划。此工具不会保存文件；返回的计划必须由用户在 Desktop 渲染器中明确确认后才能提交。",
    promptSnippet: "创建 DOCX 或 XLSX 修改计划，不直接保存",
    promptGuidelines: [
      "office_document_plan 只生成计划，不能批准或保存；创建后等待用户在 Desktop 的确认界面操作。",
      "XLSX 仅支持 set_cell_value 修改 inspection 返回的现有非公式 cell；必须原样复述 sheetId、cellId、address、revision、expectedValue 和 SHA-256。",
      "必须使用 office_document_inspect 返回的 revision、part、relatedPartId、paragraphId、runId、expectedText 和 expectedTextSha256，不要猜测。",
      "页眉和页脚只支持 replace_related_text_run；批注只支持 replace_comment_text_run。",
      "跨运行替换仅限同一可编辑段落；段落插入/删除仅限正文；样式修改仅支持 bold/italic。",
    ],
    parameters: Type.Object({
      documentId: Type.String({ minLength: 1 }),
      operations: Type.Array(
        Type.Union([
          setCellValueOperation,
          replaceTextRunOperation,
          replaceRelatedTextRunOperation,
          replaceCommentTextRunOperation,
          replaceTextRangeOperation,
          insertParagraphAfterOperation,
          deleteParagraphOperation,
          setTextRunStyleOperation,
        ]),
        { minItems: 1, maxItems: 100 },
      ),
    }),
    async execute(_toolCallId, params) {
      const spreadsheetOperations: SetCellValueOperation[] = [];
      const documentOperations: DocumentOperation[] = [];
      for (const operation of params.operations) {
        if (operation.type === "set_cell_value") spreadsheetOperations.push(operation);
        else if (operation.type === "replace_text_range") {
          documentOperations.push({
            ...operation,
            precondition: {
              ...operation.precondition,
              expectedTextSha256: createHash("sha256").update(operation.precondition.expectedText).digest("hex"),
            },
          });
        } else documentOperations.push(operation);
      }
      let input: PlanOfficeDocumentInput;
      if (spreadsheetOperations.length === params.operations.length) {
        input = {
          documentId: params.documentId,
          envelope: { protocolVersion: 1, operations: spreadsheetOperations },
        };
      } else if (documentOperations.length === params.operations.length) {
        input = {
          documentId: params.documentId,
          envelope: { protocolVersion: 1, operations: documentOperations },
        };
      } else throw new Error("DOCX 与 XLSX operation 不能混合在同一计划中");
      return jsonResult(
        (await requestHost({
          type: "office-document.plan",
          projectId: requireEnvironment("PI_BROWSER_SESSION_PROJECT_ID"),
          input,
        })) as OfficeDocumentPlan,
      );
    },
  });
}

async function requestHost(request: OfficeDocumentHostRequest): Promise<unknown> {
  const port = requireEnvironment("PI_OFFICE_HOST_PORT");
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-desktop-office-token": requireEnvironment("PI_OFFICE_TOKEN"),
      "x-desktop-office-session-token": requireEnvironment("PI_BROWSER_SESSION_TOKEN"),
      "x-desktop-office-session-project-id": requireEnvironment("PI_BROWSER_SESSION_PROJECT_ID"),
      "x-desktop-office-session-thread-id": requireEnvironment("PI_BROWSER_SESSION_THREAD_ID"),
    },
    body: JSON.stringify(request),
  });
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Office 文档宿主返回无效响应");
  }
  const result = payload as Record<string, unknown>;
  if (!response.ok || result.ok !== true) {
    throw new Error(
      typeof result.error === "string" ? result.error : `Office 文档宿主请求失败（HTTP ${response.status}）`,
    );
  }
  return result.data;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Office 文档宿主桥接不可用：缺少 ${name}`);
  return value;
}
function jsonResult(
  value: OfficeDocumentHandle[] | OfficeDocumentInspection | OfficeDocumentPlan,
): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}
