import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CliRunner } from "../cli.ts";
import { describeFile, resolveFilePath, textResult, toolError } from "./shared.ts";

/**
 * Inspection tools: schema validation, HTML/PNG rendering (so the model can
 * "see" documents), and the built-in help system for property discovery.
 */
export function registerInspectTools(pi: ExtensionAPI, runner: CliRunner): void {
  pi.registerTool({
    name: "office_validate",
    label: "Validate Office Document",
    description:
      "按 OpenXML 模式校验文档结构，输出校验结果与发现的问题。交付前检查用；只读，不修改文档。",
    promptSnippet: "校验 Office 文档的 OpenXML 结构完整性。",
    promptGuidelines: [
      "office_validate: 编辑完成后、交付前运行一次，配合 office_view issues 模式检查。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      try {
        const { text } = await runner.run(["validate", file, "--json"], { cwd, signal, json: true });
        return textResult(text || "校验通过。", { command: "validate", file });
      } catch (error) {
        throw toolError(`office_validate ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_render",
    label: "Render Office Document",
    description:
      "把文档渲染为独立 HTML 文件（浏览器可打开）或按页 PNG 截图（多模态模型可读图检查排版），使用 OfficeCLI 内置高保真渲染引擎。不修改原文档。",
    promptSnippet: "把 Office 文档渲染成 HTML 或 PNG，检查实际排版效果。",
    promptGuidelines: [
      "office_render: 检查标题溢出、形状重叠、表格布局等视觉问题时使用；渲染 PNG 后用内置 read 工具查看图片。",
      "office_render: 多页文档渲染 PNG 时指定 page；html 模式一次输出整份文档。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      format: StringEnum(["html", "png"], { description: "html=独立 HTML 文件；png=按页截图。" }),
      output: Type.Optional(
        Type.String({ description: "输出文件路径；默认与文档同目录的 <文件名>.<html|png>。" }),
      ),
      page: Type.Optional(Type.Integer({ minimum: 1, description: "png 模式指定页码（默认第一页）。" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      const ext = params.format === "html" ? "html" : "png";
      const output = params.output ? resolveFilePath(params.output, cwd) : `${file}.${ext}`;
      try {
        const args = ["view", file, params.format === "html" ? "html" : "screenshot", "-o", output];
        if (params.format === "png" && params.page !== undefined) args.push("--page", String(params.page));
        const { text } = await runner.run(args, { cwd, signal, timeoutMs: 300_000 });
        const hint =
          params.format === "png"
            ? `截图已保存到 ${output}。用 read 工具查看该图片以检查渲染效果。`
            : `HTML 已保存到 ${output}，可用浏览器打开查看。`;
        return textResult(text || hint, { command: "render", file, format: params.format, output });
      } catch (error) {
        throw toolError(`office_render ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_help",
    label: "OfficeCLI Help",
    description:
      "查询 OfficeCLI 的命令/元素帮助：某格式的元素清单、某元素的属性与取值格式、某命令的用法。不确定属性名或取值格式时先查帮助，不要猜测。",
    promptSnippet: "查询 OfficeCLI 的元素、属性与命令帮助。",
    promptGuidelines: [
      "office_help: 不确定 set/add 的属性名、取值格式、路径语法时，先跑 office_help 再操作。",
      "office_help: topic 可传 \"docx set paragraph\"（格式+动词+元素）或 \"pptx add shape\" 等形式。",
    ],
    parameters: Type.Object({
      topic: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "帮助主题，如 \"docx set paragraph\"、\"xlsx set cell\"、\"pptx add shape\"、\"view\"。",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      try {
        const tokens = params.topic.trim().split(/\s+/);
        const { text } = await runner.run(["help", ...tokens], { cwd, signal, timeoutMs: 60_000 });
        return textResult(text, { command: "help", topic: params.topic });
      } catch (error) {
        throw toolError(`office_help ${params.topic}`, error);
      }
    },
  });
}
