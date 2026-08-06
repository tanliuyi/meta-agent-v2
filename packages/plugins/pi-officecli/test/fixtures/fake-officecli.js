// Fake officecli binary for plugin tests.
// Replays deterministic JSON envelopes based on argv.
import fs from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}
function fail(code, error, suggestion) {
  process.stderr.write(JSON.stringify({ success: false, error: { code, error, suggestion } }) + "\n");
  process.exit(1);
}

if (cmd === "--version") {
  process.stdout.write("officecli 1.0.143 (fake)\n");
  process.exit(0);
}

// Any command touching a path containing "missing" fails with a structured error.
if (args.some((a) => a.includes("missing"))) {
  fail("not_found", "Target not found (fake)", "Valid path: /body/p[1]");
}

if (cmd === "create") out({ success: true, path: args[1] });

if (cmd === "view") {
  const file = args[1];
  const mode = args[2];
  if (args.includes("--json")) {
    out({ success: true, mode, file, items: [{ tag: "paragraph", path: "/body/p[1]", attributes: { text: "Hello" } }] });
  }
  process.stdout.write(`[${mode}] ${file}\nParagraph: Hello\n`);
  process.exit(0);
}

if (cmd === "get") out({ success: true, tag: "paragraph", path: args[2], attributes: { text: "Hello", style: "Normal" } });
if (cmd === "query") out({ success: true, results: [{ path: "/body/p[1]", attributes: { style: "Heading1" } }] });

if (["set", "add", "remove", "move", "swap"].includes(cmd)) {
  out({ success: true, path: args[1], applied: args.slice(1) });
}

if (cmd === "batch") {
  const idx = args.indexOf("--input");
  const items = idx >= 0 ? JSON.parse(fs.readFileSync(args[idx + 1], "utf8")) : [];
  out({ success: true, applied: items.length, input: args[idx + 1] });
}

if (cmd === "merge") out({ success: true, output: args[2], data: args[4] ?? null });
if (cmd === "validate") out({ success: true, valid: true, issues: 0 });
if (cmd === "dump") {
  const idx = args.indexOf("-o");
  out({ success: true, output: args[idx + 1], items: 3 });
}
if (cmd === "help") {
  process.stdout.write("Usage: officecli " + args.slice(1).join(" ") + " --prop <key>=<value>\n");
  process.exit(0);
}

// Commands meant to hang (e.g. --hang) block forever; tests abort them.
if (cmd === "hang") {
  process.stdin.resume();
  await new Promise(() => {});
}

out({ success: true, echo: args });
