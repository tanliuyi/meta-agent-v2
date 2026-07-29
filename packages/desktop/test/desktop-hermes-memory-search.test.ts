import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DatabaseManager } from "../src/main/pi/extensions/pi-hermes-memory/store/db.ts";
import { MemoryStore } from "../src/main/pi/extensions/pi-hermes-memory/store/memory-store.ts";
import {
  getMemories,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
} from "../src/main/pi/extensions/pi-hermes-memory/store/sqlite-memory-store.ts";
import { registerMemorySearchTool } from "../src/main/pi/extensions/pi-hermes-memory/tools/memory-search-tool.ts";
import { registerMemoryTool } from "../src/main/pi/extensions/pi-hermes-memory/tools/memory-tool.ts";

function captureMemorySearchTool(dbManager: DatabaseManager): ToolDefinition {
  let definition: ToolDefinition | undefined;
  const pi: Pick<ExtensionAPI, "registerTool"> = {
    registerTool(tool) {
      definition = tool;
    },
  };
  registerMemorySearchTool(pi, dbManager);
  if (!definition) throw new Error("memory_search tool was not registered");
  return definition;
}

function captureMemoryTool(store: MemoryStore, dbManager: DatabaseManager): ToolDefinition {
  let definition: ToolDefinition | undefined;
  const pi: Pick<ExtensionAPI, "registerTool"> = {
    registerTool(tool) {
      definition = tool;
    },
  };
  registerMemoryTool(pi as ExtensionAPI, store, null, dbManager);
  if (!definition) throw new Error("memory tool was not registered");
  return definition;
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

async function execute(tool: ToolDefinition, params: object): Promise<string> {
  const result = await tool.execute("test", params, undefined, undefined, {} as ExtensionContext);
  return resultText(result);
}

describe("Desktop Hermes memory_search tool", () => {
  it("searches project and global ordinary memories without a category filter", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-memory-search-"));
    const dbManager = new DatabaseManager(root);
    try {
      syncMemoryEntry(dbManager, {
        content: "desktop helper project marker",
        target: "memory",
        project: "meta-agent-v2",
      });
      syncMemoryEntry(dbManager, {
        content: "desktop helper global marker",
        target: "memory",
        project: null,
      });
      syncMemoryEntry(dbManager, {
        content: "desktop helper categorized marker",
        target: "failure",
        project: null,
        category: "convention",
      });
      const tool = captureMemorySearchTool(dbManager);
      expect(Value.Check(tool.parameters, { query: "desktop", project: null })).toBe(true);
      expect(Value.Check(tool.parameters, { query: "desktop", project: "" })).toBe(false);
      expect(Value.Check(tool.parameters, { query: "desktop", limit: 20 })).toBe(true);
      expect(Value.Check(tool.parameters, { query: "desktop", limit: 1.5 })).toBe(false);
      expect(Value.Check(tool.parameters, { query: "desktop", limit: 21 })).toBe(false);
      expect(Value.Check(tool.parameters, { query: "" })).toBe(false);
      expect(Value.Check(tool.parameters, { query: "   " })).toBe(false);

      const projectResult = await execute(tool, {
        query: "desktop helper",
        project: "meta-agent-v2",
        target: "memory",
      });
      expect(projectResult).toContain("desktop helper project marker");
      expect(projectResult).not.toContain("desktop helper global marker");

      const globalResult = await execute(tool, {
        query: "desktop helper",
        project: null,
        target: "memory",
      });
      expect(globalResult).toContain("desktop helper global marker");
      expect(globalResult).not.toContain("desktop helper project marker");
      expect(globalResult).not.toContain("desktop helper categorized marker");

      const categoryResult = await execute(tool, {
        query: "desktop helper",
        category: "convention",
      });
      expect(categoryResult).toContain("desktop helper categorized marker");
      expect(categoryResult).not.toContain("desktop helper global marker");
    } finally {
      dbManager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects contradictory category and ordinary-memory filters", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-memory-search-"));
    const dbManager = new DatabaseManager(root);
    try {
      const tool = captureMemorySearchTool(dbManager);
      await expect(
        execute(tool, {
          query: "desktop",
          target: "memory",
          category: "convention",
        }),
      ).resolves.toBe('category only applies to target="failure"; omit category to search target="memory"');
      await expect(execute(tool, { query: "desktop", project: "" })).resolves.toBe("project must not be empty");
    } finally {
      dbManager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps direct SQLite mutations inside the explicit global scope", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-memory-search-"));
    const dbManager = new DatabaseManager(root);
    try {
      syncMemoryEntry(dbManager, { content: "shared fallback marker", target: "memory", project: null });
      syncMemoryEntry(dbManager, { content: "shared fallback marker", target: "memory", project: "project-a" });

      replaceSyncedMemories(dbManager, "shared fallback marker", {
        content: "global fallback replacement",
        target: "memory",
        project: null,
      });
      expect(getMemories(dbManager, { project: null }).map((entry) => entry.content)).toEqual([
        "global fallback replacement",
      ]);
      expect(getMemories(dbManager, { project: "project-a" }).map((entry) => entry.content)).toEqual([
        "shared fallback marker",
      ]);

      removeSyncedMemories(dbManager, "global fallback replacement", { target: "memory", project: null });
      syncMemoryEntry(dbManager, { content: "shared fallback marker", target: "memory", project: null });
      removeExactSyncedMemories(dbManager, "shared fallback marker", { target: "memory", project: null });
      expect(getMemories(dbManager, { project: null })).toEqual([]);
      expect(getMemories(dbManager, { project: "project-a" }).map((entry) => entry.content)).toEqual([
        "shared fallback marker",
      ]);
    } finally {
      dbManager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps failure metadata searchable through add, replace, and remove", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-memory-search-"));
    const dbManager = new DatabaseManager(root);
    const store = new MemoryStore({
      memoryMode: "policy-only",
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      projectCharLimit: 5000,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      failureInjectionEnabled: true,
      failureInjectionMaxAgeDays: 7,
      failureInjectionMaxEntries: 5,
      nudgeToolCalls: 15,
      consolidationTimeoutMs: 60_000,
      memoryDir: root,
    });
    try {
      await store.loadFromDisk();
      const memoryTool = captureMemoryTool(store, dbManager);
      const searchTool = captureMemorySearchTool(dbManager);

      await execute(memoryTool, {
        action: "add",
        target: "failure",
        content: "desktop failure crudcreated marker",
        category: "tool-quirk",
        failure_reason: "original reason",
      });
      expect(
        await execute(searchTool, {
          query: "crudcreated",
          target: "failure",
          category: "tool-quirk",
          project: null,
        }),
      ).toContain("desktop failure crudcreated marker");

      await execute(memoryTool, {
        action: "replace",
        target: "failure",
        old_text: "desktop failure crudcreated marker",
        content: "desktop failure crudreplaced marker",
        category: "tool-quirk",
        failure_reason: "replacement reason",
      });
      const replaced = await execute(searchTool, {
        query: "crudreplaced",
        target: "failure",
        category: "tool-quirk",
        project: null,
      });
      expect(replaced).toContain("desktop failure crudreplaced marker");
      expect(replaced).toContain("replacement reason");
      expect(
        await execute(searchTool, {
          query: "crudcreated",
          target: "failure",
          category: "tool-quirk",
          project: null,
        }),
      ).toContain("No memories found");

      await execute(memoryTool, {
        action: "replace",
        target: "failure",
        old_text: "desktop failure crudreplaced marker",
        content: "desktop failure crudpreserved marker",
        category: "tool-quirk",
        failure_reason: "",
      });
      const preserved = await execute(searchTool, {
        query: "crudpreserved",
        target: "failure",
        category: "tool-quirk",
        project: null,
      });
      expect(preserved).toContain("desktop failure crudpreserved marker");
      expect(preserved).toContain("replacement reason");

      await execute(memoryTool, {
        action: "remove",
        target: "failure",
        old_text: "desktop failure crudpreserved marker",
      });
      expect(
        await execute(searchTool, {
          query: "crudpreserved",
          target: "failure",
          category: "tool-quirk",
          project: null,
        }),
      ).toContain("No memories");
    } finally {
      dbManager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
