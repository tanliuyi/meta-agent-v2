import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option("--port", "3000"));
const dataPath = resolve(option("--data", join(skillDir, "data", "diagram.json")));
const publicDir = resolve(option("--public", join(skillDir, "dist", "app")));
const host = "127.0.0.1";

const emptyDiagram = {
  metadata: { title: "工艺流程及产污节点图", figure: "图 1", source: "待确认", status: "draft" },
  nodes: [],
  edges: [],
  pollutionSources: [],
  treatments: [],
  legend: []
};

const nodeTypes = new Set(["process", "pollution", "treatment", "terminal", "input", "boundary"]);
const edgeKinds = new Set(["material", "waste-gas", "waste-water", "solid-waste", "reuse", "utility", "boundary"]);

mkdirSync(dirname(dataPath), { recursive: true });
if (!existsSync(dataPath)) writeFileSync(dataPath, JSON.stringify(emptyDiagram, null, 2), "utf8");

const readDiagram = () => JSON.parse(readFileSync(dataPath, "utf8"));
const validate = (diagram) => {
  if (!diagram || !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) throw new Error("diagram.nodes 和 diagram.edges 必须是数组");
  const ids = new Set();
  for (const node of diagram.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error("节点 ID 必须唯一且非空");
    if (typeof node.label !== "string" || !node.label.trim()) throw new Error("节点 label 必须是非空字符串");
    if (node.type !== undefined && (typeof node.type !== "string" || !node.type.trim())) throw new Error("节点 type 必须是非空字符串");
    if (node.x !== undefined && typeof node.x !== "number") throw new Error("节点 x 必须是数字");
    if (node.y !== undefined && typeof node.y !== "number") throw new Error("节点 y 必须是数字");
    if (node.pollutants !== undefined && !Array.isArray(node.pollutants)) throw new Error("节点 pollutants 必须是数组");
    ids.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of diagram.edges) {
    if (!edge.id || edgeIds.has(edge.id)) throw new Error("连线 ID 必须唯一且非空");
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error("连线端点必须引用现有节点");
    if (edge.kind !== undefined && (typeof edge.kind !== "string" || !edge.kind.trim())) throw new Error("连线 kind 必须是非空字符串");
    edgeIds.add(edge.id);
  }
  if (diagram.pollutionSources !== undefined && !Array.isArray(diagram.pollutionSources)) throw new Error("pollutionSources 必须是数组");
  if (diagram.treatments !== undefined && !Array.isArray(diagram.treatments)) throw new Error("treatments 必须是数组");
};
const saveDiagram = (diagram) => {
  validate(diagram);
  const tempPath = `${dataPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(diagram, null, 2), "utf8");
  renameSync(tempPath, dataPath);
};
const body = async (request) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
};
const sendJson = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
const sendError = (response, error) => sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
const staticFile = (response, pathname) => {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(file)) return sendJson(response, 404, { error: "Not found" });
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
  response.writeHead(200, { "content-type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  response.end(readFileSync(file));
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const match = url.pathname.match(/^\/api\/(nodes|edges)(?:\/([^/]+))?$/);
    if (url.pathname === "/api/diagram") {
      if (request.method === "GET") return sendJson(response, 200, readDiagram());
      if (request.method === "PUT") { const diagram = await body(request); saveDiagram(diagram); return sendJson(response, 200, diagram); }
    }
    if (match) {
      const [, kind, id] = match;
      const key = kind;
      const diagram = readDiagram();
      if (request.method === "POST" && !id) {
        const item = await body(request);
        if (!item.id || diagram[key].some((entry) => entry.id === item.id)) throw new Error("ID 缺失或重复");
        diagram[key].push(item); saveDiagram(diagram); return sendJson(response, 201, item);
      }
      const index = diagram[key].findIndex((entry) => entry.id === id);
      if (index < 0) return sendJson(response, 404, { error: "资源不存在" });
      if (request.method === "PATCH") { diagram[key][index] = { ...diagram[key][index], ...(await body(request)), id }; saveDiagram(diagram); return sendJson(response, 200, diagram[key][index]); }
      if (request.method === "DELETE") { diagram[key].splice(index, 1); if (key === "nodes") diagram.edges = diagram.edges.filter((edge) => edge.from !== id && edge.to !== id); saveDiagram(diagram); return sendJson(response, 200, { ok: true }); }
    }
    return staticFile(response, url.pathname);
  } catch (error) { return sendError(response, error); }
});
server.listen(port, host, () => console.log(`EIA flow editor: http://${host}:${port}`));
