import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner, formatOfficeError, officeErrorFrom, runOfficeCli, tryParseJson } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { truncateToolOutput } from "../src/output.ts";

const FAKE_BIN = path.join(import.meta.dirname, "fixtures", "fake-officecli.js");

function fakeConfig(): Record<string, string | number | boolean> {
  return { binaryPath: FAKE_BIN, dataDir: tmpdir() };
}

function fakeArgs(...rest: string[]): string[] {
  return [FAKE_BIN, ...rest];
}

test("tryParseJson parses envelopes and rejects plain text", () => {
  assert.deepEqual(tryParseJson('{"success":true}'), { success: true });
  assert.deepEqual(tryParseJson("[1,2]"), [1, 2]);
  assert.equal(tryParseJson("not json"), null);
  assert.equal(tryParseJson(""), null);
});

test("officeErrorFrom extracts structured errors", () => {
  const info = officeErrorFrom(
    '{"success":false,"error":{"error":"Slide 50 not found","code":"not_found","suggestion":"Valid range: 1-8"}}',
  );
  assert.deepEqual(info, {
    code: "not_found",
    message: "Slide 50 not found",
    suggestion: "Valid range: 1-8",
  });
  assert.equal(officeErrorFrom("plain text"), null);
  assert.equal(officeErrorFrom('{"success":true}'), null);
});

test("formatOfficeError renders code, message and suggestion", () => {
  assert.equal(
    formatOfficeError({ code: "not_found", message: "nope", suggestion: "try /body/p[1]" }),
    "[not_found] nope。建议: try /body/p[1]",
  );
});

test("runOfficeCli captures stdout and exit code", async () => {
  const result = await runOfficeCli(process.execPath, fakeArgs("--version"), { cwd: tmpdir() });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /officecli 1\.0\.143 \(fake\)/);
});

test("runOfficeCli surfaces a structured failure envelope as an error", async () => {
  const runner = createRunner(resolveConfig({ binaryPath: FAKE_BIN, dataDir: tmpdir() }));
  await assert.rejects(
    runner.run(["get", "missing.docx", "/body/p[1]", "--json"], { cwd: tmpdir(), json: true }),
    (error: Error) => error.message.includes("[not_found]") && error.message.includes("Target not found"),
  );
});

test("runOfficeCli aborts a hanging command via timeout", async () => {
  const result = await runOfficeCli(process.execPath, fakeArgs("hang"), { cwd: tmpdir(), timeoutMs: 200 });
  assert.equal(result.killed, true);
  assert.notEqual(result.code, 0);
});

test("runner passes --json output through as parsed", async () => {
  const runner = createRunner(resolveConfig({ binaryPath: FAKE_BIN, dataDir: tmpdir() }));
  const { text, parsed } = await runner.run(["view", "report.docx", "outline", "--json"], {
    cwd: tmpdir(),
    json: true,
  });
  assert.equal(typeof text, "string");
  assert.ok(parsed && typeof parsed === "object");
  assert.equal((parsed as { mode: string }).mode, "outline");
});

test("truncateToolOutput keeps short output untouched", () => {
  assert.equal(truncateToolOutput("hello"), "hello");
});

test("truncateToolOutput truncates large output with a hint", () => {
  const big = "x".repeat(60_000);
  const out = truncateToolOutput(big);
  assert.ok(out.length < big.length);
  assert.match(out, /输出已截断/);
  assert.match(out, /office_render/);
});

test("batch temp input file is written by tools and removed afterwards", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-batch-"));
  try {
    const input = path.join(dir, "batch.json");
    writeFileSync(input, JSON.stringify([{ command: "set", path: "/body/p[1]", props: { text: "Hi" } }]));
    const result = await runOfficeCli(
      process.execPath,
      fakeArgs("batch", "book.xlsx", "--input", input, "--json"),
      { cwd: dir },
    );
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.applied, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
