import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { CodexMcpServer } from "../../shared/codex-plugin-companions.ts";
import type { ResolvedExtensionEntry } from "../../shared/desktop-extension-contracts.ts";
import { resolveCodexCompanionPath } from "../plugins/codex/codex-plugin-companions.ts";
import { executeCodexScript } from "./codex-script-process.ts";

const TIMEOUT_MS = 30_000;

/** Host-owned adapter. Factories only register tools; drafts never start plugin processes. */
export function createCodexCompanionExtension(entry: ResolvedExtensionEntry): InlineExtension {
  const companions = entry.codexCompanions;
  if (entry.source !== "codex" || !companions || entry.entryPath) throw new Error("Invalid Codex resource entry");
  const prefix = `codex_${createHash("sha256").update(entry.id).digest("hex").slice(0, 16)}`;
  return {
    name: entry.id,
    factory(pi) {
      const shutdown = new AbortController();
      pi.on("session_shutdown", async () => {
        shutdown.abort();
      });
      if (companions.scripts.length > 0)
        pi.registerTool({
          name: `${prefix}_script`,
          label: `${entry.displayName} script`,
          description: `Explicitly execute a ${entry.displayName} script in the plugin directory. JavaScript uses Node; Python uses the platform Python command. Allowed scripts: ${JSON.stringify(companions.scripts)}. No shell expansion.`,
          parameters: Type.Object(
            { script: Type.String(), args: Type.Optional(Type.Array(Type.String())) },
            { additionalProperties: false },
          ),
          async execute(_id, { script, args }, signal) {
            if (!companions.scripts.includes(script)) throw new Error("CODEX_SCRIPT_NOT_APPROVED");
            const path = await resolveCodexCompanionPath(companions.rootPath, script);
            signal?.throwIfAborted();
            const executable =
              extname(script) === ".py" ? (process.platform === "win32" ? "python" : "python3") : process.execPath;
            const result = await executeCodexScript(executable, [path, ...(args ?? [])], {
              cwd: companions.rootPath,
              signal: AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])]),
              env: { ...getDefaultEnvironment(), CODEX_PLUGIN_ROOT: companions.rootPath, ELECTRON_RUN_AS_NODE: "1" },
            });
            return { content: [{ type: "text", text: result }], details: {} };
          },
        });
      if (Object.keys(companions.mcpServers).length > 0)
        pi.registerTool({
          name: `${prefix}_mcp`,
          label: `${entry.displayName} MCP`,
          description: `Access ${entry.displayName} MCP tools. Specify server and omit tool to list tools and schemas; then specify tool and arguments to call it. Each request opens and closes a connection. Servers: ${JSON.stringify(Object.keys(companions.mcpServers))}.`,
          parameters: Type.Object(
            {
              server: Type.String(),
              tool: Type.Optional(Type.String()),
              arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
              cursor: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
          async execute(_id, params, signal) {
            if (!Object.hasOwn(companions.mcpServers, params.server)) throw new Error("CODEX_MCP_SERVER_NOT_APPROVED");
            const server = companions.mcpServers[params.server];
            const result = await requestCodexMcp(
              server,
              params,
              AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])]),
            );
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
          },
        });
    },
  };
}

async function requestCodexMcp(
  server: CodexMcpServer,
  params: { tool?: string; arguments?: Record<string, unknown>; cursor?: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  boundedSignal.throwIfAborted();
  const client = new Client({ name: "meta-agent-codex-companions", version: "1.0.0" });
  const transport =
    server.type === "stdio"
      ? new StdioClientTransport({
          ...server,
          env: { ...getDefaultEnvironment(), ...server.env },
          stderr: "ignore",
          maxBufferSize: 1024 * 1024,
        })
      : new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers, signal: boundedSignal },
        });
  try {
    await client.connect(transport, { signal: boundedSignal, timeout: TIMEOUT_MS });
    return params.tool === undefined
      ? await client.listTools({ cursor: params.cursor }, { signal: boundedSignal, timeout: TIMEOUT_MS })
      : await client.callTool({ name: params.tool, arguments: params.arguments ?? {} }, undefined, {
          signal: boundedSignal,
          timeout: TIMEOUT_MS,
        });
  } catch {
    // Transport errors can embed headers, commands or environment values.
    throw new Error(boundedSignal.aborted ? "CODEX_MCP_CANCELLED" : "CODEX_MCP_REQUEST_FAILED");
  } finally {
    if (transport instanceof StreamableHTTPClientTransport) {
      await transport.terminateSession().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
