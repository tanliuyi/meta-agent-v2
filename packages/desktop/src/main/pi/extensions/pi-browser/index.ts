/**
 * pi-browser：把内置浏览器（IAB）暴露为 Pi runtime 的 browser_* 工具集。
 *
 * 工具执行经 BrowserClient（本地 HTTP RPC，env: PI_BROWSER_HOST_PORT /
 * PI_BROWSER_TOKEN）调用 main 进程 BrowserManager，控制 renderer 侧
 * `<webview>` 的 guest webContents（导航/快照/点击/输入/滚动）。
 *
 * 用户与 Agent 共享同一视图（spec D6）：任何浏览器操作都在应用内可见。
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type {
  DesktopPluginModuleExport,
  PluginApiCatalogV1,
  PluginMethodExecutionContext,
} from "../../../../shared/desktop-extension-contracts.ts";
import { normalizePluginSchema } from "../legacy-plugin-adapter.ts";
import {
  collectBrowserToolDefinitions,
  type RegisterBrowserToolsOptions,
  registerBrowserTools,
} from "./register-tools.ts";

const browserResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

function createBrowserPluginMethods() {
  return collectBrowserToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: normalizePluginSchema(tool.parameters) as TSchema,
    result: browserResultSchema,
    concurrency: "serial" as const,
    async execute(params: unknown, signal: AbortSignal, ctx: PluginMethodExecutionContext) {
      const extensionContext = ctx.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Browser plugin context is unavailable");
      const result = await tool.execute(ctx.callId, params, signal, undefined, extensionContext);
      const textParts: string[] = [];
      for (const part of result.content) {
        if (part.type === "text") textParts.push(part.text);
        if (part.type === "image") {
          ctx.attach({ type: "image", data: part.data, mimeType: part.mimeType });
          textParts.push("[image attachment]");
        }
      }
      return { text: textParts.join("\\n") };
    },
  }));
}

export const desktopPlugin: DesktopPluginModuleExport = {
  schemaVersion: 1,
  methods: createBrowserPluginMethods(),
};

export const pluginCallCatalog = {
  schemaVersion: 1 as const,
  pluginId: "pi-browser",
  methods: [...desktopPlugin.methods]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, parameters, result, concurrency }) => ({
      name,
      description,
      parameters: parameters as unknown as Record<string, never>,
      result: result as unknown as Record<string, never>,
      concurrency: concurrency ?? "serial",
    })),
} satisfies PluginApiCatalogV1;

export default function piBrowser(pi: ExtensionAPI, options: RegisterBrowserToolsOptions = {}): void {
  pi.on("resources_discover", async () => ({
    skillPaths: [fileURLToPath(new URL("./skills/pi-browser/SKILL.md", import.meta.url))],
  }));
  registerBrowserTools(pi, options);
}
