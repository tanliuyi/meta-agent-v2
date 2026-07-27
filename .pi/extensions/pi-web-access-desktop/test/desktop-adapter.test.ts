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

test("forwards supported Extension API members", () => {
  const marker = () => "forwarded";
  const pi = { sendMessage: marker } as unknown as ExtensionAPI;

  assert.equal(createDesktopApi(pi).sendMessage, marker);
});
