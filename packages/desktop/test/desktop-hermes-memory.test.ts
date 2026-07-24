import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  execChildPrompt,
  resolveChildPiInvocation,
  resolveWatchedChildPiInvocation,
} from "../src/main/pi/extensions/pi-hermes-memory/handlers/pi-child-process.ts";
import { DatabaseManager } from "../src/main/pi/extensions/pi-hermes-memory/store/db.ts";
import { NodeSqliteDatabase } from "../src/main/pi/extensions/pi-hermes-memory/store/sqlite.ts";

const promptArgs = ["-p", "--no-session", "prompt"];

describe("Desktop Hermes Memory process adaptation", () => {
  it("uses the sidecar Node executable with the resolved Pi CLI on every platform", () => {
    expect(
      resolveChildPiInvocation(promptArgs, {
        platform: "linux",
        execPath: "/runtime/node",
        piCliPath: "/app/pi/cli.js",
      }),
    ).toEqual({ command: "/runtime/node", args: ["/app/pi/cli.js", ...promptArgs] });
  });

  it("disables every Hermes CLI fallback in a programmatic subagent profile", async () => {
    const exec = vi.fn();
    await expect(
      execChildPrompt({ exec }, "remember this", { childProcessDisabled: true }, { timeoutMs: 1_000 }),
    ).rejects.toThrow("subprocess transport is disabled");
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs the compiled JavaScript watchdog", () => {
    const invocation = resolveWatchedChildPiInvocation(
      { command: "/runtime/node", args: ["/app/pi/cli.js", ...promptArgs] },
      10_000,
      "/tmp/cancel",
    );

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]?.replaceAll("\\", "/")).toMatch(/\/child-process-watchdog\.js$/);
    expect(invocation.args.slice(1, 4)).toEqual(["10000", "/tmp/cancel", "/runtime/node"]);
  });

  it("initializes the Hermes schema through the Node SQLite adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-schema-"));
    const manager = new DatabaseManager(root);
    try {
      const database = manager.getDb();
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get(),
      ).toEqual({ name: "memories" });
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'").get(),
      ).toEqual({ name: "memory_fts" });
    } finally {
      manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provides the Hermes synchronous SQLite surface with Node FTS5 and backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-hermes-sqlite-"));
    const source = join(root, "source.db");
    const destination = join(root, "backup.db");
    try {
      const database = new NodeSqliteDatabase(source, { timeout: 1_000 });
      database.exec("CREATE VIRTUAL TABLE memories USING fts5(content)");
      const inserted = database.prepare("INSERT INTO memories(content) VALUES (?)").run("durable memory");
      expect(inserted.changes).toBe(1);
      expect(database.prepare("SELECT content FROM memories WHERE memories MATCH ?").get("durable")).toEqual({
        content: "durable memory",
      });
      expect(database.pragma("journal_mode", { simple: true })).toBe("delete");

      const rollback = database.transaction(() => {
        database.prepare("INSERT INTO memories(content) VALUES (?)").run("rolled back");
        throw new Error("rollback");
      });
      expect(rollback).toThrow("rollback");
      expect(database.prepare("SELECT content FROM memories ORDER BY rowid").all()).toEqual([
        { content: "durable memory" },
      ]);

      await database.backup(destination);
      database.close();
      const backup = new NodeSqliteDatabase(destination, { readonly: true, fileMustExist: true });
      expect(backup.prepare("SELECT content FROM memories").all()).toEqual([{ content: "durable memory" }]);
      backup.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
