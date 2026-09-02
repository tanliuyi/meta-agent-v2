#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const rawArgs = process.argv.slice(2);
const urlIndex = rawArgs.indexOf("--url");
const base = urlIndex >= 0 ? rawArgs[urlIndex + 1] : process.env.EIA_FLOW_URL ?? "http://127.0.0.1:3000";
const cliArgs = urlIndex >= 0 ? rawArgs.filter((_, index) => index !== urlIndex && index !== urlIndex + 1) : rawArgs;
const [command = "get", ...args] = cliArgs;
const request = async (path, method = "GET", value) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
};
const jsonArg = async (value) => value.startsWith("@") ? JSON.parse(await readFile(value.slice(1), "utf8")) : JSON.parse(value);
const usage = () => console.error("Usage: diagram-cli.mjs get | validate | save <json|@file> | node add|update|delete <id> [json] | edge add|update|delete <id> [json]");

try {
  let result;
  if (command === "get") result = await request("/api/diagram");
  else if (command === "validate") { result = await request("/api/diagram"); console.log(`valid: ${result.nodes.length} nodes, ${result.edges.length} edges`); process.exit(0); }
  else if (command === "save") result = await request("/api/diagram", "PUT", await jsonArg(args[0]));
  else if (command === "node" || command === "edge") {
    const [operation, id, raw] = args;
    if (operation === "add") { const value = await jsonArg(id); result = await request("/api/operations", "POST", { operations: [{ op: "add", target: command, id: value.id, value }] }); }
    else if (operation === "update") result = await request("/api/operations", "POST", { operations: [{ op: "update", target: command, id, patch: await jsonArg(raw) }] });
    else if (operation === "delete") result = await request("/api/operations", "POST", { operations: [{ op: "delete", target: command, id }] });
    else { usage(); process.exitCode = 1; }
  } else { usage(); process.exitCode = 1; }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
