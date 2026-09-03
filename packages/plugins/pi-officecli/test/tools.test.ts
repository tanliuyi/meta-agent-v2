import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import piOfficeCli from "../index.ts";
import { createRunner } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { registerInspectTools } from "../src/tools/inspect.ts";
import { registerReadTools } from "../src/tools/read.ts";
import { registerWriteTools } from "../src/tools/write.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const FAKE_BIN = path.join(import.meta.dirname, "fixtures", "fake-officecli.js");

type AnyTool = ToolDefinition<any, any, any>;

interface FakePi {
  tools: Map<string, AnyTool>;
  config: Record<string, string | number | boolean>;
  events: string[];
}

function createFakePi(config: Record<string, string | number | boolean>): FakePi {
  const fake: FakePi = { tools: new Map(), config, events: [] };
  const pi = {
    getConfig: () => fake.config,
    registerTool: (tool: AnyTool) => {
      fake.tools.set(tool.name, tool);
    },
    on: () => undefined,
    on: (event: string) => {
      fake.events.push(event);
    },
  } as unknown as ExtensionAPI;
  const runner = createRunner(resolveConfig(config));
  registerReadTools(pi, runner);
  registerWriteTools(pi, runner);
  registerInspectTools(pi, runner);
  return fake;
}

const EXPECTED_TOOLS = [
  "office_view",
  "office_get",
  "office_query",
  "office_dump",
  "office_create",
  "office_edit",
  "office_batch",
  "office_merge",
  "office_validate",
  "office_render",
  "office_help",
];

test("default factory does not register model-facing Office tools", () => {
  const tools: unknown[] = [];
  piOfficeCli({
    getConfig: () => ({ binaryPath: FAKE_BIN, dataDir: tmpdir() }),
    registerTool: (tool: unknown) => tools.push(tool),
    on: () => undefined,
  } as unknown as ExtensionAPI);
  assert.deepEqual(tools, []);
});

test("market manifest requires Desktop client 0.0.42 or newer", () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "market-manifest.json"), "utf8"));
  assert.equal(manifest.desktop.minVersion, "0.0.42");
});
function toolCtx(cwd: string) {
  return { cwd } as unknown as Parameters<AnyTool["execute"]>[4];
}

async function callTool(
  tool: AnyTool,
  params: Record<string, unknown>,
  cwd: string,
): Promise<AgentToolResult<unknown>> {
  return (await tool.execute("test-call", params, undefined, undefined, toolCtx(cwd))) as AgentToolResult<unknown>;
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

test("plugin registers all office tools with labels and schemas", () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  assert.deepEqual([...fake.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of fake.tools.values()) {
    assert.ok(tool.label.length > 0, `${tool.name} has a label`);
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.ok(tool.parameters !== undefined, `${tool.name} has a parameters schema`);
  }
});

test("office_create resolves relative paths against cwd and checks extension", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-tools-"));
  try {
    const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
    const tool = fake.tools.get("office_create")!;
    const result = await callTool(tool, { file: "docs/report.docx" }, dir);
    assert.match(textOf(result), /report\.docx/);
    assert.match(textOf(result), /docs/);
    await assert.rejects(callTool(tool, { file: "notes.txt" }, dir), /仅支持 \.docx\/\.xlsx\/\.pptx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("office_view returns structured content for json format", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_view")!;
  const result = await callTool(tool, { file: "report.docx", mode: "outline", format: "json" }, tmpdir());
  const details = result.details as { mode: string };
  assert.equal(details.mode, "outline");
  const parsed = JSON.parse(textOf(result)) as { mode: string };
  assert.equal(parsed.mode, "outline");
});

test("office_get passes path and depth", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_get")!;
  const result = await callTool(tool, { file: "report.docx", path: "/body/p[1]", depth: 2 }, tmpdir());
  const details = result.details as { path: string };
  assert.equal(details.path, "/body/p[1]");
  const parsed = JSON.parse(textOf(result)) as { attributes: { text: string } };
  assert.equal(parsed.attributes.text, "Hello");
});

test("office_edit builds set args with props", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_edit")!;
  const result = await callTool(
    tool,
    { file: "report.docx", op: "set", path: "/body/p[1]", props: { bold: true, color: "FF0000", text: "Hi" } },
    tmpdir(),
  );
  const parsed = JSON.parse(textOf(result)) as { applied: string[] };
  const applied = parsed.applied;
  assert.ok(applied[0].endsWith("report.docx"), `file arg resolved: ${applied[0]}`);
  assert.deepEqual(applied.slice(1), [
    "/body/p[1]",
    "--prop",
    "bold=true",
    "--prop",
    "color=FF0000",
    "--prop",
    "text=Hi",
    "--json",
  ]);
});

test("office_edit requires target path for set", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_edit")!;
  await assert.rejects(callTool(tool, { file: "a.docx", op: "set", props: { bold: true } }, tmpdir()), /set 需要 path 或 selector/);
});

test("office_batch writes a temp input file and cleans up", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-batch2-"));
  try {
    const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
    const tool = fake.tools.get("office_batch")!;
    const ops = JSON.stringify([
      { command: "set", path: "/body/p[1]", props: { text: "A" } },
      { command: "set", path: "/body/p[2]", props: { text: "B" } },
    ]);
    const result = await callTool(tool, { file: "book.xlsx", operations: ops }, dir);
    const parsed = JSON.parse(textOf(result)) as { applied: number; input: string };
    assert.equal(parsed.applied, 2);
    assert.ok(!existsSync(parsed.input), "temp batch file must be removed");  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("office_batch rejects malformed operations JSON", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_batch")!;
  await assert.rejects(callTool(tool, { file: "a.xlsx", operations: "{oops" }, tmpdir()), /不是合法的 JSON/);
  await assert.rejects(callTool(tool, { file: "a.xlsx", operations: "[]" }, tmpdir()), /JSON 数组/);
});

test("office_merge parses data and rejects same template/output", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_merge")!;
  const result = await callTool(
    tool,
    { template: "tpl.docx", output: "out.docx", data: '{"client":"Acme"}' },
    tmpdir(),
  );
  const parsed = JSON.parse(textOf(result)) as { output: string };
  assert.ok(parsed.output.endsWith("out.docx"));
  await assert.rejects(
    callTool(tool, { template: "same.docx", output: "same.docx", data: "{}" }, tmpdir()),
    /不能与模板相同/,
  );
  await assert.rejects(
    callTool(tool, { template: "t.docx", output: "o.docx", data: "not json" }, tmpdir()),
    /不是合法的 JSON/,
  );
});

test("office_merge accepts scalar JSON data without crashing", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_merge")!;
  const result = await callTool(tool, { template: "tpl.docx", output: "out.docx", data: "null" }, tmpdir());
  const parsed = JSON.parse(textOf(result)) as { success: boolean; output: string };
  assert.equal(parsed.success, true);
  assert.ok(parsed.output.endsWith("out.docx"));
  const strResult = await callTool(tool, { template: "tpl.docx", output: "out2.docx", data: '"Acme"' }, tmpdir());
  const strParsed = JSON.parse(textOf(strResult)) as { success: boolean };
  assert.equal(strParsed.success, true);
});

test("office_merge passes large data via a temp file that is cleaned up", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_merge")!;
  const big = JSON.stringify({ payload: "x".repeat(5000) });
  const result = await callTool(tool, { template: "tpl.docx", output: "out.docx", data: big }, tmpdir());
  const parsed = JSON.parse(textOf(result)) as { data: string };
  assert.ok(parsed.data.includes("pi-officecli-"), `large data goes through a temp file, got: ${parsed.data}`);
  assert.ok(!existsSync(parsed.data), "temp data file must be removed");
  const small = await callTool(tool, { template: "tpl.docx", output: "out2.docx", data: '{"a":1}' }, tmpdir());
  const smallParsed = JSON.parse(textOf(small)) as { data: string };
  assert.equal(smallParsed.data, '{"a":1}');
});

test("office_create rejects an existing file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-tools-"));
  try {
    writeFileSync(path.join(dir, "exists.docx"), "placeholder");
    const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
    const tool = fake.tools.get("office_create")!;
    await assert.rejects(callTool(tool, { file: "exists.docx" }, dir), /文件已存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("office_dump writes blueprint and returns output path", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_dump")!;
  const result = await callTool(tool, { file: "report.docx", path: "/body" }, tmpdir());
  const parsed = JSON.parse(textOf(result)) as { success: boolean; output: string };
  assert.equal(parsed.success, true);
  assert.ok(parsed.output.endsWith("report.docx.blueprint.json"));
});

test("office_help queries the built-in help", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_help")!;
  const result = await callTool(tool, { topic: "docx set paragraph" }, tmpdir());
  assert.match(textOf(result), /Usage: officecli docx set paragraph/);
});

test("office_edit builds add/remove/move/swap args", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const cwd = tmpdir();
  const tool = fake.tools.get("office_edit")!;
  const add = await callTool(
    tool,
    { file: "a.docx", op: "add", parent: "/body", type: "paragraph", props: { text: "Hi" } },
    cwd,
  );
  const addParsed = JSON.parse(textOf(add)) as { applied: string[] };
  assert.deepEqual(addParsed.applied.slice(1), ["/body", "--type", "paragraph", "--prop", "text=Hi", "--json"]);

  const remove = await callTool(tool, { file: "a.docx", op: "remove", path: "/body/p[1]" }, cwd);
  const removeParsed = JSON.parse(textOf(remove)) as { applied: string[] };
  assert.deepEqual(removeParsed.applied.slice(1), ["/body/p[1]", "--json"]);

  const move = await callTool(tool, { file: "a.docx", op: "move", path: "/body/p[1]", to: "/body", index: 2 }, cwd);
  const moveParsed = JSON.parse(textOf(move)) as { applied: string[] };
  assert.deepEqual(moveParsed.applied.slice(1), ["/body/p[1]", "--to", "/body", "--index", "2", "--json"]);

  const swap = await callTool(tool, { file: "a.docx", op: "swap", path: "/body/p[1]", path2: "/body/p[2]" }, cwd);
  const swapParsed = JSON.parse(textOf(swap)) as { applied: string[] };
  assert.deepEqual(swapParsed.applied.slice(1), ["/body/p[1]", "/body/p[2]", "--json"]);

  await assert.rejects(callTool(tool, { file: "a.docx", op: "move", path: "/body/p[1]" }, cwd), /move 需要 --to/);
  await assert.rejects(callTool(tool, { file: "a.docx", op: "swap", path: "/body/p[1]" }, cwd), /swap 需要 path 与 path2/);
});

test("office_validate and office_render return success results", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const validate = fake.tools.get("office_validate")!;
  const vResult = await callTool(validate, { file: "report.docx" }, tmpdir());
  const vParsed = JSON.parse(textOf(vResult)) as { valid: boolean };
  assert.ok(vParsed.valid);
  const render = fake.tools.get("office_render")!;
  const rResult = await callTool(render, { file: "report.docx", format: "png", page: 2 }, tmpdir());
  const rDetails = rResult.details as { output: string };
  assert.ok(rDetails.output.endsWith(".png"));
});

test("structured officecli failure reaches the model as a readable error", async () => {
  const fake = createFakePi({ binaryPath: FAKE_BIN, dataDir: tmpdir() });
  const tool = fake.tools.get("office_get")!;
  await assert.rejects(
    callTool(tool, { file: "missing.docx", path: "/body/p[1]" }, tmpdir()),
    (error: Error) => error.message.includes("[not_found]") && error.message.includes("Valid path"),
  );
});
