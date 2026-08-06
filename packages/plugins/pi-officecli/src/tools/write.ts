import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { CliRunner } from "../cli.ts";
import type { BatchItem } from "../types.ts";
import { describeFile, resolveFilePath, textResult, toolError } from "./shared.ts";

const EDIT_OPS = ["set", "add", "remove", "move", "swap"] as const;

/**
 * Inline JSON passed via argv; keep well under the 32,767-char Windows command
 * line limit (escaped JSON can grow several-fold). Larger data goes through a
 * temp file, which `--data` also accepts.
 */
const INLINE_DATA_MAX = 4096;

function buildPropArgs(props: Record<string, string | number | boolean>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    args.push("--prop", `${key}=${String(value)}`);
  }
  return args;
}

/**
 * Write tools: create documents and mutate the document DOM. All mutations run
 * through pi's file mutation queue so they serialize against built-in tools
 * editing the same file.
 */
export function registerWriteTools(pi: ExtensionAPI, runner: CliRunner): void {
  pi.registerTool({
    name: "office_create",
    label: "Create Office Document",
    description:
      "创建一个空白 .docx/.xlsx/.pptx 文档（类型由扩展名决定）。已存在的文件不会被覆盖，请换一个文件名。",
    promptSnippet: "创建空白 Office 文档。",
    promptGuidelines: [
      "office_create: 先创建空文档，再用 office_edit / office_batch 填充内容。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "目标文档路径（.docx/.xlsx/.pptx），相对于会话工作目录。" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      const ext = path.extname(file).toLowerCase();
      if (ext !== ".docx" && ext !== ".xlsx" && ext !== ".pptx") {
        throw new Error(`office_create 失败: 仅支持 .docx/.xlsx/.pptx，得到 "${ext || "(无扩展名)"}"`);
      }
      try {
        return await withFileMutationQueue(file, async () => {
          if (existsSync(file)) {
            throw new Error(
              `office_create 失败: 文件已存在: ${describeFile(file, cwd)}（不会覆盖已有文件，请换一个文件名）`,
            );
          }
          const { text } = await runner.run(["create", file], { cwd, signal });
          return textResult(
            text || `已创建 ${describeFile(file, cwd)}。`,
            { command: "create", file },
          );
        });
      } catch (error) {
        throw toolError(`office_create ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_edit",
    label: "Edit Office Document Element",
    description:
      "修改文档 DOM：set=修改元素属性（文本/字体/颜色/样式等），add=添加元素（--type 指定元素类型，如 paragraph/slide/shape/sheet/cell），remove=删除，move=移动（--to 目标父节点，--index/--after/--before 定位），swap=交换两元素。修改立即生效并落盘。",
    promptSnippet: "添加、修改、删除或移动 Office 文档中的元素。",
    promptGuidelines: [
      "office_edit: 不确定元素类型或可用属性时，先跑 office_help（如 office_help 传 docx set paragraph）再操作。",
      "office_edit: 批量改动用 office_batch 一次提交，失败自动回滚，比多次 office_edit 更稳。",
      "office_edit: 删除前先用 office_get 确认路径；优先使用稳定 ID 路径（@paraId/@id）。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      op: StringEnum([...EDIT_OPS], { description: "操作类型。" }),
      path: Type.Optional(Type.String({ description: "目标元素路径（set/remove/move/swap 需要）。" })),
      path2: Type.Optional(Type.String({ description: "swap 的第二个元素路径。" })),
      parent: Type.Optional(Type.String({ description: "add 的父路径（如 /body、/Sheet1、/），默认 /。" })),
      type: Type.Optional(Type.String({ description: "add 的元素类型（paragraph/slide/shape/sheet/cell 等）。" })),
      props: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
          { description: "属性键值对（如 title、text、bold、color、size、style、value）。" },
        ),
      ),
      to: Type.Optional(Type.String({ description: "move 的目标父路径。" })),
      index: Type.Optional(Type.Integer({ description: "move 的目标位置（1-based），与 after/before 互斥。" })),
      after: Type.Optional(Type.String({ description: "move 到某元素之后。" })),
      before: Type.Optional(Type.String({ description: "move 到某元素之前。" })),
      selector: Type.Optional(Type.String({ description: "CSS 风格选择器替代 path 定位目标。" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      const target = params.selector !== undefined ? params.selector : params.path;
      try {
        return await withFileMutationQueue(file, async () => {
          const args = [params.op, file];
          switch (params.op) {
            case "set":
              if (target === undefined) throw new Error("set 需要 path 或 selector");
              args.push(target);
              if (params.props) args.push(...buildPropArgs(params.props));
              break;
            case "add":
              args.push(params.parent ?? "/");
              if (params.type) args.push("--type", params.type);
              if (params.props) args.push(...buildPropArgs(params.props));
              break;
            case "remove":
              if (target === undefined) throw new Error("remove 需要 path 或 selector");
              args.push(target);
              break;
            case "move":
              if (params.path === undefined) throw new Error("move 需要 path");
              if (!params.to) throw new Error("move 需要 --to 目标父路径");
              args.push(params.path, "--to", params.to);
              if (params.index !== undefined) args.push("--index", String(params.index));
              if (params.after) args.push("--after", params.after);
              if (params.before) args.push("--before", params.before);
              break;
            case "swap":
              if (params.path === undefined || params.path2 === undefined) {
                throw new Error("swap 需要 path 与 path2");
              }
              args.push(params.path, params.path2);
              break;
          }
          args.push("--json");
          const { text } = await runner.run(args, { cwd, signal, json: true });
          return textResult(text || `已执行 ${params.op}。`, {
            command: params.op,
            file,
            path: params.path ?? params.selector ?? params.parent,
          });
        });
      } catch (error) {
        throw toolError(`office_edit ${params.op} ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_batch",
    label: "Batch Edit Office Document",
    description:
      "在单次打开/保存周期内原子执行多条文档操作（JSON 数组）。任一条失败则整批回滚（默认）。每条: {\"command\"|\"op\": \"set|add|remove|move|swap\", \"path\"|\"parent\"|\"to\"..., \"type\"?, \"props\"?: {...}}。适合批量填充表格、逐项修改样式。",
    promptSnippet: "原子批量修改 Office 文档（多条操作一次提交，失败回滚）。",
    promptGuidelines: [
      "office_batch: 需要 2 条以上关联修改时用它，保证原子性并节省往返。",
      "office_batch: 先用 office_get / office_query 确认目标路径，再构造 operations。",
    ],
    parameters: Type.Object({
      file: Type.String({ minLength: 1, description: "文档路径，相对于会话工作目录。" }),
      operations: Type.String({
        minLength: 2,
        maxLength: 2_000_000,
        description: "JSON 数组字符串，元素为 batch item（command/op/path/props 等）。",
      }),
      bestEffort: Type.Optional(
        Type.Boolean({ description: "true 时保留已成功的操作，即使部分失败（默认 false=整批回滚）。" }),
      ),
      stopOnError: Type.Optional(Type.Boolean({ description: "true 时遇到第一条失败即停止（配合 bestEffort）。" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = resolveFilePath(params.file, cwd);
      let items: unknown;
      try {
        items = JSON.parse(params.operations);
      } catch {
        throw new Error("office_batch 失败: operations 不是合法的 JSON");
      }
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("office_batch 失败: operations 必须是至少含一条命令的 JSON 数组");
      }
      try {
        return await withFileMutationQueue(file, async () => {
          const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-"));
          const input = path.join(dir, "batch.json");
          try {
            writeFileSync(input, JSON.stringify(items as BatchItem[]), { mode: 0o600 });
            const args = ["batch", file, "--input", input, "--json"];
            if (params.bestEffort) args.push("--best-effort");
            if (params.stopOnError) args.push("--stop-on-error");
            const { text } = await runner.run(args, { cwd, signal, json: true });
            return textResult(text || `批处理完成：${items.length} 条操作。`, {
              command: "batch",
              file,
              count: items.length,
            });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        });
      } catch (error) {
        throw toolError(`office_batch ${describeFile(file, cwd)}`, error);
      }
    },
  });

  pi.registerTool({
    name: "office_merge",
    label: "Merge Template with Data",
    description:
      "把模板文档（.docx/.xlsx/.pptx）中的 {{key}} 占位符替换为 JSON 数据并生成新文档。占位符可出现在段落、表格单元格、形状、页眉页脚、图表标题中。模板不被修改。",
    promptSnippet: "用 JSON 数据填充文档模板中的 {{key}} 占位符。",
    promptGuidelines: [
      "office_merge: 批量生成同版式文档（报告/合同/发票）时用它，避免逐份重写版式。",
      "office_merge: data 为 JSON 对象或数组字符串，键与模板中的 {{key}} 对应。",
    ],
    parameters: Type.Object({
      template: Type.String({ minLength: 1, description: "模板文档路径，相对于会话工作目录。" }),
      output: Type.String({ minLength: 1, description: "生成的目标文档路径（.docx/.xlsx/.pptx）。" }),
      data: Type.String({
        minLength: 1,
        maxLength: 1_000_000,
        description: "JSON 字符串（对象或数组），如 {\"client\":\"Acme\",\"total\":\"$5,200\"}。",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const template = resolveFilePath(params.template, cwd);
      const output = resolveFilePath(params.output, cwd);
      let data: unknown;
      try {
        data = JSON.parse(params.data);
      } catch {
        throw new Error("office_merge 失败: data 不是合法的 JSON");
      }
      if (template === output) {
        throw new Error("office_merge 失败: 输出路径不能与模板相同（模板不会被修改）");
      }
      const keys = data !== null && typeof data === "object" ? Object.keys(data) : [];
      try {
        return await withFileMutationQueue(output, async () => {
          let dir: string | null = null;
          try {
            let dataArg = params.data;
            if (params.data.length > INLINE_DATA_MAX) {
              dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-"));
              const input = path.join(dir, "data.json");
              writeFileSync(input, params.data, { mode: 0o600 });
              dataArg = input;
            }
            const { text } = await runner.run(["merge", template, output, "--data", dataArg], {
              cwd,
              signal,
            });
            return textResult(text || `已生成 ${describeFile(output, cwd)}（数据键: ${keys.join(", ")}）。`, {
              command: "merge",
              template,
              output,
            });
          } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
          }
        });
      } catch (error) {
        throw toolError(`office_merge ${describeFile(template, cwd)}`, error);
      }
    },
  });
}

