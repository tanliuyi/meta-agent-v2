import type { AgentToolResult, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executePluginProgram, PluginCallRunManager } from "./plugin-call-runtime.ts";
import { type PluginCallExecution, PluginMethodDispatcher } from "./plugin-method-dispatcher.ts";
import type { PluginMethodRegistry } from "./plugin-method-registry.ts";

export const pluginCallParameters = Type.Object(
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

export class PluginCallRegistryHolder {
  readonly generation: string;
  private registry?: PluginMethodRegistry;
  private dispatcher?: PluginMethodDispatcher;
  private stale = false;
  private readonly manager = new PluginCallRunManager();

  constructor(generation: string) {
    this.generation = generation;
  }

  bind(registry: PluginMethodRegistry, cwd: string): void {
    if (this.registry || this.stale) throw new Error("PLUGIN_GENERATION_STALE");
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

  getRunManager(): PluginCallRunManager {
    if (this.stale) throw new Error("PLUGIN_GENERATION_STALE");
    return this.manager;
  }
}

export function createPluginCallExtension(holder: PluginCallRegistryHolder, cwd: string): InlineExtension {
  return {
    name: "<inline:desktop-plugin-call>",
    factory: async (pi) => {
      pi.registerTool({
        name: "plugin_call",
        label: "Plugin call",
        description:
          "Execute an erasable TypeScript program using enabled Desktop plugin APIs. Read the relevant plugin skill before use. Return only the final value needed by the model.",
        parameters: pluginCallParameters,
        executionMode: "parallel",
        async execute(toolCallId, params, signal, onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
          const details: PluginCallExecution & {
            kind: "plugin-call-details-v1";
            description: string;
            runId: string;
            generation: string;
          } = {
            kind: "plugin-call-details-v1",
            description: params.description,
            runId: toolCallId,
            generation: holder.generation,
            calls: [],
            logs: [],
            attachments: [],
            active: true,
          };
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
                    ? "(plugin_call completed with no output)"
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
          } finally {
            if (updateTimer) clearTimeout(updateTimer);
          }
        },
      });
    },
  };
}
