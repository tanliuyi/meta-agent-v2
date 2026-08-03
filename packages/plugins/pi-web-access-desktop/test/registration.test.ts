import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWebAccessDesktop from "../index.ts";

test("registers Desktop-compatible tools, commands, and lifecycle handlers", () => {
  const tools: ToolDefinition[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  let shortcutRegistrations = 0;
  const pi = {
    getConfig() {
      return {};
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerShortcut() {
      shortcutRegistrations += 1;
    },
    on(event: string) {
      events.push(event);
    },
  } as unknown as ExtensionAPI;

  piWebAccessDesktop(pi);

  const toolNames = tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("fetch_content"));
  assert.ok(toolNames.includes("get_search_content"));
  assert.deepEqual(commands.sort(), ["curator", "google-account", "search", "websearch"]);
  assert.ok(events.includes("session_start"));
  assert.ok(events.includes("session_shutdown"));
  assert.equal(shortcutRegistrations, 0);
  assert.ok(tools.every((tool) => tool.renderCall === undefined && tool.renderResult === undefined));
});
