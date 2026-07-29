import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatabaseManager } from "../store/db.ts";
import { hasMemories, searchMemories } from "../store/sqlite-memory-store.ts";
import type { MemoryCategory } from "../types.ts";

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerMemorySearchTool(pi: Pick<ExtensionAPI, "registerTool">, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

Returns matching memory entries with project context and dates.`,
    promptSnippet: "Search extended memory store (unlimited capacity)",
    promptGuidelines: [
      "Use memory_search when you need context beyond what is in the system prompt.",
      "Use memory_search to find project-specific memories or user preferences.",
      "Use memory_search with category only for categorized failure/lesson memories.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "Search query. Use natural language or specific terms.",
      }),
      project: Type.Optional(
        Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
          description: "Filter by project name. Omit for all scopes; pass null for global memories only.",
        }),
      ),
      target: Type.Optional(
        StringEnum(["memory", "user", "failure"] as const, {
          description: "Filter by target type. Categorized entries use the failure target.",
        }),
      ),
      category: Type.Optional(
        StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
          description: "Filter categorized failure/lesson memories only.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results to return (default: 10)." }),
      ),
    }),
    execute: async (
      _id: string,
      args: { query: string; project?: string | null; target?: string; category?: string; limit?: number },
    ) => {
      const query = args.query;
      const project = args.project === null ? null : args.project?.trim();
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const effectiveTarget = category ? "failure" : target;
      const requestedLimit = args.limit;
      const limit =
        typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
          ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 20)
          : 10;

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: "query is required" };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      if (args.project !== undefined && args.project !== null && project?.length === 0) {
        const result: SearchResult = { success: false, message: "project must not be empty" };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      if (category && target && target !== "failure") {
        const result: SearchResult = {
          success: false,
          message: `category only applies to target="failure"; omit category to search target="${target}"`,
        };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, {
        project,
        target: effectiveTarget,
        category,
        limit,
      });

      if (results.length === 0 && !hasMemories(dbManager)) {
        const result: SearchResult = {
          success: false,
          message: "No memories in extended store yet. Use the memory tool with add action to store memories.",
        };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      if (results.length === 0) {
        const result: SearchResult = {
          success: true,
          count: 0,
          message: `No memories found matching "${query}". Try a different search term or broader query.`,
        };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : "[global]";
        const targetLabel = entry.target === "user" ? "👤" : entry.target === "failure" ? "⚠️" : "🧠";
        const categoryLabel = entry.category ? ` [${entry.category}]` : "";
        output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: "text" as const, text: output.trim() }], details: finalResult };
    },
  });
}
