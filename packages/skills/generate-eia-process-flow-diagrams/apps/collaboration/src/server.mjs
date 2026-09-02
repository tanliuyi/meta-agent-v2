import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataPath = resolve(root, "data/diagram.json");
const port = Number(process.env.EIA_COLLAB_PORT ?? 1234);
const apiPort = Number(process.env.EIA_API_PORT ?? 3000);

const mapFromObject = (value) => {
  const map = new Y.Map();
  for (const [key, field] of Object.entries(value)) map.set(key, field);
  return map;
};
const objectFromMap = (map) => Object.fromEntries(map.entries());
const setDiagram = (doc, diagram) => {
  const metadata = doc.getMap("metadata");
  const nodes = doc.getMap("nodes");
  const edges = doc.getMap("edges");
  const collections = doc.getMap("collections");
  doc.transact(() => {
    for (const [key, value] of Object.entries(diagram.metadata ?? {})) metadata.set(key, value);
    for (const node of diagram.nodes ?? []) nodes.set(node.id, mapFromObject(node));
    for (const edge of diagram.edges ?? []) edges.set(edge.id, mapFromObject(edge));
    collections.set("pollutionSources", diagram.pollutionSources ?? []);
    collections.set("treatments", diagram.treatments ?? []);
    collections.set("legend", diagram.legend ?? []);
  }, "initial-load");
};
const getDiagram = (doc) => ({
  metadata: objectFromMap(doc.getMap("metadata")),
  nodes: [...doc.getMap("nodes").values()].map(objectFromMap),
  edges: [...doc.getMap("edges").values()].map(objectFromMap),
  pollutionSources: doc.getMap("collections").get("pollutionSources") ?? [],
  treatments: doc.getMap("collections").get("treatments") ?? [],
  legend: doc.getMap("collections").get("legend") ?? [],
});
const patchMap = (map, patch) => { for (const [key, value] of Object.entries(patch)) map.set(key, value); };
const applyOperations = (doc, operations) => {
  const nodes = doc.getMap("nodes");
  const edges = doc.getMap("edges");
  doc.transact(() => {
    for (const operation of operations) {
      const collection = operation.target === "node" ? nodes : operation.target === "edge" ? edges : null;
      if (!collection || !["add", "update", "delete"].includes(operation.op)) throw new Error("无效操作");
      const current = collection.get(operation.id);
      if (operation.op === "add") {
        if (current) throw new Error(`ID 已存在：${operation.id}`);
        collection.set(operation.id, mapFromObject({ ...operation.value, id: operation.id }));
      }
      if (operation.op === "update") {
        if (!current) throw new Error(`资源不存在：${operation.id}`);
        patchMap(current, { ...operation.patch, id: operation.id });
      }
      if (operation.op === "delete") {
        if (!current) throw new Error(`资源不存在：${operation.id}`);
        collection.delete(operation.id);
        if (operation.target === "node") for (const [edgeId, edge] of edges.entries()) if (edge.get("from") === operation.id || edge.get("to") === operation.id) edges.delete(edgeId);
      }
    }
  }, { actorType: "api", operationId: crypto.randomUUID() });
};
const sendJson = (response, status, value) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };

await mkdir(dirname(dataPath), { recursive: true });
const server = new Server({
  port,
  async onLoadDocument() { const doc = new Y.Doc(); setDiagram(doc, JSON.parse(await readFile(dataPath, "utf8"))); return doc; },
  async onStoreDocument({ document }) {
    const nextDiagram = getDiagram(document);
    let previousDiagram = null;
    try { previousDiagram = JSON.parse(await readFile(dataPath, "utf8")); } catch { /* first save */ }
    const previousEdges = new Map((previousDiagram?.edges ?? []).map((edge) => [edge.id, edge]));
    for (const edge of nextDiagram.edges) {
      const previous = previousEdges.get(edge.id);
      if (!previous) continue;
      for (const field of ["waypoints", "sourceHandle", "targetHandle"]) {
        if (edge[field] === undefined && previous[field] !== undefined) edge[field] = previous[field];
      }
    }
    await writeFile(dataPath, JSON.stringify(nextDiagram, null, 2), "utf8");
  },
});
const documentForApi = async () => server.hocuspocus.documents.get("diagram") ?? server.hocuspocus.createDocument("diagram", new Request(`http://127.0.0.1:${port}/api`), "api", {});
const apiServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${apiPort}`);
    if (url.pathname === "/api/diagram" && request.method === "GET") return sendJson(response, 200, getDiagram(await documentForApi()));
    if (url.pathname === "/api/operations" && request.method === "POST") { let text = ""; for await (const chunk of request) text += chunk; const document = await documentForApi(); applyOperations(document, JSON.parse(text).operations ?? []); return sendJson(response, 200, getDiagram(document)); }
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) { console.error(error); return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
});
await server.listen();
await new Promise((resolveApi) => apiServer.listen(apiPort, "127.0.0.1", resolveApi));
console.log(`EIA collaboration service: ws://127.0.0.1:${port}`);
console.log(`EIA operation API: http://127.0.0.1:${apiPort}`);
