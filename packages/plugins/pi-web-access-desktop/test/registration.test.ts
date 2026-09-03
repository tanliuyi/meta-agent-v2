import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWebAccessDesktop from "../index.ts";

test("registers tools through the Desktop-owned registration boundary", () => {
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
  assert.deepEqual(toolNames.sort(), ["fetch_content", "get_search_content", "source_check", "web_search"]);
  assert.deepEqual(commands.sort(), ["curator", "google-account", "search", "websearch"]);
  assert.deepEqual(events.sort(), ["resources_discover", "session_shutdown", "session_start", "session_tree"]);
  assert.equal(shortcutRegistrations, 0);
  assert.equal(tools.every((tool) => tool.renderCall === undefined && tool.renderResult === undefined), true);
});
