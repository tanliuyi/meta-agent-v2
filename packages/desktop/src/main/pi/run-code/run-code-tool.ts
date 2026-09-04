import type { AgentToolResult, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PluginMethodDispatcher, type RunCodeExecution } from "./plugin-method-dispatcher.ts";
import type { PluginMethodRegistry } from "./plugin-method-registry.ts";
import { normalizePluginError, type RunCodeError } from "./run-code-errors.ts";
import { executePluginProgram, RunCodeRunManager } from "./run-code-runtime.ts";

export const RunCodeParameters = Type.Object(
  {
    code: Type.String({
      description: "The body of an async TypeScript function. Top-level await and return are available.",
      maxLength: 262144,
    }),
    description: Type.String({
      description: "A clear 5-10 word summary shown in the UI.",
      minLength: 1,
      maxLength: 160,
    }),
  },
  { additionalProperties: false },
);

/** 保存当前 worker generation 的 run_code 方法表和运行中的 worker。 */
export class RunCodeRegistryHolder {
  readonly generation: string;
  private registry?: PluginMethodRegistry;
  private dispatcher?: PluginMethodDispatcher;
  private stale = false;
  private readonly manager = new RunCodeRunManager();

  constructor(generation: string) {
    this.generation = generation;
  }

  bind(registry: PluginMethodRegistry, cwd: string): void {
    if (this.stale) throw new Error("PLUGIN_GENERATION_STALE");
    this.registry = registry;
    this.dispatcher = new PluginMethodDispatcher(registry, cwd);
  }

  async dispose(): Promise<void> {
    this.stale = true;
    this.registry = undefined;
    this.dispatcher = undefined;
    await this.manager.dispose();
  }

  getDispatcher(): PluginMethodDispatcher {
    if (!this.registry || !this.dispatcher || this.stale) throw new Error("PLUGIN_GENERATION_STALE");
    return this.dispatcher;
  }

  getRunManager(): RunCodeRunManager {
    if (this.stale) throw new Error("PLUGIN_GENERATION_STALE");
    return this.manager;
  }
}

/** 注册唯一的 run_code 外层工具；插件方法仍由 direct/native 工具独立注册。 */
export function createRunCodeExtension(holder: RunCodeRegistryHolder, cwd: string): InlineExtension {
  return {
    name: "<inline:desktop-run-code>",
    factory: async (pi) => {
      pi.registerTool({
        name: "run_code",
        label: "Run code",
        description:
          'Run an async TypeScript program that combines enabled Desktop plugin APIs. Use `await plugin["canonical-plugin-id"].method(args)` with the plugin ID and method documented by its skill. Combine independent calls with `Promise.all`, await dependent calls in order, and explicitly return only the result needed by the model. Direct Pi tools remain available for simple one-step operations; use run_code for multi-step, batch, conditional, or composed plugin work. The host `pi` object is not injected, so do not guess methods or write `pi.someTool(...)`.',
        promptSnippet: 'run_code({ code: "return await plugin[\\"plugin.id\\"].method(args)", description: "..." })',
        promptGuidelines: [
          "Use direct native tools for one simple action; use run_code when several plugin actions belong to one decision.",
          "Use Promise.all for independent read-only calls and await when one call depends on another.",
          "Read the plugin skill for the exact plugin ID, method names, and argument shape before composing calls.",
          "Return only the data needed for the next reasoning step.",
        ],
        parameters: RunCodeParameters,
        executionMode: "parallel",
        async execute(toolCallId, params, signal, onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
          const details: RunCodeExecution & {
            kind: "run-code-details-v1";
            description: string;
            runId: string;
            generation: string;
          } = {
            kind: "run-code-details-v1",
            description: params.description,
            runId: toolCallId,
            generation: holder.generation,
            calls: [],
            logs: [],
            attachments: [],
            active: true,
          };
          Object.defineProperty(details, "toolContext", { value: _ctx });
          let updateTimer: ReturnType<typeof setTimeout> | undefined;
          const publishUpdate = () => {
            if (!onUpdate || updateTimer) return;
            updateTimer = setTimeout(() => {
              updateTimer = undefined;
              onUpdate({ content: [], details });
            }, 100);
          };
          try {
            const value = await executePluginProgram(
              params.code,
              holder.getDispatcher(),
              toolCallId,
              signal,
              cwd,
              undefined,
              details,
              holder.getRunManager(),
              publishUpdate,
            );
            if (updateTimer) clearTimeout(updateTimer);
            const content: AgentToolResult<unknown>["content"] = [
              {
                type: "text",
                text:
                  value === undefined
                    ? "(run_code completed with no output)"
                    : typeof value === "string"
                      ? value
                      : JSON.stringify(value, null, 2),
              },
            ];
            for (const attachment of details.attachments ?? []) {
              if (attachment.type === "image") {
                content.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
              }
            }
            const persistedDetails = {
              ...details,
              attachments: (details.attachments ?? []).map((attachment) =>
                attachment.type === "image"
                  ? {
                      type: "image" as const,
                      contentIndex: content.findIndex(
                        (part) =>
                          part.type === "image" &&
                          part.data === attachment.data &&
                          part.mimeType === attachment.mimeType,
                      ),
                      ...(attachment.name ? { name: attachment.name } : {}),
                    }
                  : attachment,
              ),
            };
            const result: AgentToolResult<unknown> = { content, details: persistedDetails };
            onUpdate?.(result);
            return result;
          } catch (error) {
            if (updateTimer) clearTimeout(updateTimer);
            const normalized = normalizePluginError(error, "PLUGIN_METHOD_EXECUTION_FAILED");
            const result: AgentToolResult<unknown> = {
              content: [{ type: "text", text: formatRunCodeError(normalized) }],
              details: {
                ...details,
                error: {
                  code: normalized.code,
                  message: normalized.message,
                  ...(normalized.pluginId ? { pluginId: normalized.pluginId } : {}),
                  ...(normalized.method ? { method: normalized.method } : {}),
                },
              },
            };
            onUpdate?.(result);
            return result;
          } finally {
            if (updateTimer) clearTimeout(updateTimer);
          }
        },
      });
    },
  };
}

function formatRunCodeError(error: RunCodeError): string {
  const location = [error.pluginId, error.method].filter(Boolean).join(".");
  return [
    "run_code failed.",
    `code: ${error.code}`,
    ...(location ? [`method: ${location}`] : []),
    `message: ${error.message}`,
    "Use this error as tool context and correct the next run_code call.",
  ].join("\n");
}
