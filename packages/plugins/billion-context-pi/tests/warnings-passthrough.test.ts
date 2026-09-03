import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension, desktopPlugin } from "../src/index.ts";

const STATE_FILE = "/tmp/pai-acp-warnings-it.session.json";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    getConfig() { return {}; },
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

async function cleanState() {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
}

function fakeCtx(entries: any[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

async function callPluginMethod(params: unknown, ctx: unknown) {
  const method = desktopPlugin.methods.find((candidate) => candidate.name === "compress");
  assert.ok(method, "compress plugin method exists");
  const result = await method.execute(params as never, new AbortController().signal, {
    pluginId: "pi.billion-context",
    methodName: "compress",
    callId: "tc1",
    toolCallId: "tc1",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    toolContext: ctx,
    attach: () => {},
    reportProgress: () => {},
  });
  return { content: [{ type: "text", text: result.text }] };
}

async function setup(entries: any[]) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const ctx = fakeCtx(entries);
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
  return { ctx };
}

const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
const filler = (n: string) => `filler ${n} `.repeat(400);

test("软保护区排除消息 → kernel warnings 透出到结果行", async () => {
  await cleanState();
  const entries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];
  const { ctx } = await setup(entries);
  const res = await callPluginMethod(
    { content: [{ startId: "m00001", endId: "m00007", summary: "Compressed the early session content including all setup messages." }] },
    ctx,
  );
  const text = (res.content[0] as any).text as string;
  assert.match(text, /⚠️/, "warning line should be surfaced in the result");
  assert.match(text, /Excluded \d+ protected message\(s\)/, "warning should mention protected exclusions");
});
