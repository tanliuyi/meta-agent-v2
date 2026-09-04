import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDesktopApi } from "../desktop-api.ts";

const tool = {
  name: "example",
  label: "Example",
  description: "Example tool",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
  },
  renderCall: (() => ({}) as never),
  renderResult: (() => ({}) as never),
} satisfies ToolDefinition;

test("removes TUI renderers and ignores TUI shortcuts", () => {
  const registered: ToolDefinition[] = [];
  let shortcutRegistrations = 0;
  const pi = {
    registerTool(definition: ToolDefinition) {
      registered.push(definition);
    },
    registerShortcut() {
      shortcutRegistrations += 1;
    },
  } as unknown as ExtensionAPI;
  const desktopApi = createDesktopApi(pi);

  desktopApi.registerTool(tool);
  desktopApi.registerShortcut("ctrl+shift+w", { handler() {} });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "example");
  assert.equal(registered[0].renderCall, undefined);
  assert.equal(registered[0].renderResult, undefined);
  assert.equal(shortcutRegistrations, 0);
});

test("maps configured upstream tool names to stable run_code method names", () => {
  const registered: ToolDefinition[] = [];
  const pi = {
    registerTool(definition: ToolDefinition) {
      registered.push(definition);
    },
  } as unknown as ExtensionAPI;
  const desktopApi = createDesktopApi(pi, { toolNameAliases: { custom_search: "web_search" } });

  desktopApi.registerTool({ ...tool, name: "custom_search" });

  assert.equal(registered[0].name, "web_search");
});

test("routes browser open commands to Desktop's embedded browser when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-access-desktop-browser-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, "web-search.json"), '{"browser":{"openTarget":"builtin"}}\n');

  const opened: string[] = [];
  const pi = {
    exec: async () => {
      throw new Error("system browser should not be used");
    },
  } as unknown as ExtensionAPI;

  try {
    const desktopApi = createDesktopApi(pi, {
      openBrowser: async (url) => {
        opened.push(url);
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    });
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", "http://127.0.0.1:1234/curator"] : ["http://127.0.0.1:1234/curator"];

    await desktopApi.exec(command, args);

    assert.deepEqual(opened, ["http://127.0.0.1:1234/curator"]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes browser open commands to the system when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-access-desktop-system-browser-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, "web-search.json"), '{"browser":{"openTarget":"system"}}\n');

  const calls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    exec: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  try {
    const desktopApi = createDesktopApi(pi);
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", "https://example.com"] : ["https://example.com"];

    await desktopApi.exec(command, args);

    assert.deepEqual(calls, [{ command, args }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns an error when the embedded browser host is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-access-desktop-browser-host-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousBrowserEnvironment = new Map(
    [
      "PI_BROWSER_HOST_PORT",
      "PI_BROWSER_TOKEN",
      "PI_BROWSER_SESSION_TOKEN",
      "PI_BROWSER_SESSION_PROJECT_ID",
      "PI_BROWSER_SESSION_THREAD_ID",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, "web-search.json"), '{"browser":{"openTarget":"builtin"}}\n');
  for (const key of previousBrowserEnvironment.keys()) delete process.env[key];

  let execCalls = 0;
  const pi = {
    exec: async () => {
      execCalls += 1;
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  try {
    const desktopApi = createDesktopApi(pi);
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", "https://example.com"] : ["https://example.com"];

    const result = await desktopApi.exec(command, args);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /内置浏览器宿主未就绪/);
    assert.equal(execCalls, 0);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const [key, value] of previousBrowserEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("forwards supported Extension API members", () => {
  const marker = () => "forwarded";
  const pi = { sendMessage: marker } as unknown as ExtensionAPI;

  assert.equal(createDesktopApi(pi).sendMessage, marker);
});
