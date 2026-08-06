import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CliRunner } from "../cli.ts";
import { describeFile, resolveFilePath, textResult, toolError } from "./shared.ts";

const VIEW_MODES = ["outline", "text", "annotated", "stats", "issues"] as const;

/**
 * L1/L2 read tools: semantic views, DOM access, CSS-like queries, and the
 * dump-to-JSON round trip used to learn from existing documents.
 */
export function registerReadTools(pi: ExtensionAPI, runner: CliRunner): void {
  pi.registerTool({
    name: "office_view",
    label: "View Office Document",
    description:
      "读取 .docx/.xlsx/.pptx 文档的语义视图。mode: outline=结构大纲, text=纯文本, annotated=带格式注解的文本, stats=页/段/形状统计, issues=格式与结构问题列表。读取类操作，不会修改文档。",
    promptSnippet: "读取 Office 文档的结构、文本、统计或质量问题。",
    promptGuidelines: [
      "office_view: 先看 outline 了解结构，再按需深入 text 或 annotated。",
      "office_view: issues 模式用于交付前检查文档格式与结构问题。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录，也接受绝对路径。" }),
      mode: StringEnum([...VIEW_MODES], { description: "查看模式。" }),
      format: StringEnum(["text", "json"], { description: "text=可读文本；json=结构化数据（--json）。" }),
      maxLines: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10_000, description: "text 模式最大输出行数（--max-lines）。" }),
      ),
      cols: Type.Optional(
        Type.String({ minLength: 1, description: "text 模式限定列（逗号分隔，如 A,B,C），用于超大表格。" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      try {
        const args = ["view", file, params.mode];
        if (params.maxLines !== undefined) args.push("--max-lines", String(params.maxLines));
        if (params.cols !== undefined) args.push("--cols", params.cols);
        if (params.format === "json") args.push("--json");
        const { text } = await runner.run(args, { cwd, signal, json: params.format === "json" });
        return textResult(text, { command: "view", file, mode: params.mode });
      } catch (error) {
        throw toolError(`office_view ${params.mode} ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_get",
    label: "Get Office Document Element",
    description:
      "按 DOM 路径读取文档元素及其子元素，输出 JSON。路径语法: /body/p[1]、/body/tbl[2]/tr[1]、/Sheet1/A1、/slide[1]/shape[2]，1-based。使用 --depth 展开子元素。只读，不会修改文档。",
    promptSnippet: "按 DOM 路径读取 Office 文档中的任意元素。",
    promptGuidelines: [
      "office_get: 路径不确定时先对父路径加 depth=1 列出可用子元素，再精确定位。",
      "office_get: 优先使用稳定 ID 路径（如 /body/p[@paraId=...]），避免插入/删除后序号漂移。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      path: Type.String({ description: "DOM 路径，默认 / 表示整个文档。" }),
      depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "递归展开深度。" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      try {
        const args = ["get", file, params.path];
        if (params.depth !== undefined) args.push("--depth", String(params.depth));
        args.push("--json");
        const { text } = await runner.run(args, { cwd, signal, json: true });
        return textResult(text, { command: "get", file, path: params.path });
      } catch (error) {
        throw toolError(`office_get ${describeFile(file, cwd)} ${params.path}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_query",
    label: "Query Office Document",
    description:
      "CSS 风格选择器查询文档元素，输出 JSON 数组。支持 [attr=value]、:contains(\"text\")、:empty、:has(formula)、布尔 and/or，如 paragraph[style=Heading1]、cell[value>5000 or value<100]。只读。",
    promptSnippet: "用 CSS 风格选择器查询 Office 文档中的匹配元素。",
    promptGuidelines: [
      "office_query: 需要按属性筛选元素（样式、颜色、数值范围）时用它，比 office_get 逐步遍历更省 token。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      selector: Type.String({ minLength: 1, description: "CSS 风格选择器，如 paragraph[style=Heading1]。", maxLength: 2000 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      try {
        const { text } = await runner.run(["query", file, params.selector, "--json"], {
          cwd,
          signal,
          json: true,
        });
        return textResult(text, { command: "query", file, selector: params.selector });
      } catch (error) {
        throw toolError(`office_query ${describeFile(file, cwd)} ${params.selector}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_dump",
    label: "Dump Office Document to JSON Blueprint",
    description:
      "把整个文档或任意子树序列化为可重放的 batch JSON（office_batch 可直接回放），用于从现有文档学习模板或生成变体。输出写入文件并返回路径；不修改原文档。",
    promptSnippet: "把 Office 文档或子树导出为可重放的 JSON 蓝图。",
    promptGuidelines: [
      "office_dump: 用户提供范本文档时先 dump 再修改 JSON，比直接操作原文档更安全。",
      "office_dump: 默认导出整个文档；可传子树路径（docx: /body、/body/tbl[1]；xlsx: /Sheet1）缩小范围。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      path: Type.Optional(Type.String({ description: "子树路径，默认 / 表示整个文档。" })),
      output: Type.Optional(
        Type.String({ description: "输出 JSON 文件路径；默认与文档同目录的 <文件名>.blueprint.json。" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      const output = params.output ? resolveFilePath(params.output, cwd) : `${file}.blueprint.json`;
      try {
        const args = ["dump", file];
        if (params.path !== undefined) args.push(params.path);
        args.push("-o", output);
        const { text } = await runner.run(args, { cwd, signal });
        return textResult(
          text || `已导出到 ${output}。可用 office_batch 回放此蓝图，或先阅读 JSON 再修改后回放。`,
          { command: "dump", file, output, path: params.path ?? "/" },
        );
      } catch (error) {
        throw toolError(`office_dump ${describeFile(file, cwd)}`, error);
      }
    },
  });
}
