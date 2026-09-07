import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.START_MARKER) appendFileSync(process.env.START_MARKER, `${process.pid}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] };
  } else if (request.method === "tools/call") {
    if (request.params.name === "wait") return;
    result = { content: [{ type: "text", text: request.params.arguments.value ?? "ok" }] };
  } else {
    result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
