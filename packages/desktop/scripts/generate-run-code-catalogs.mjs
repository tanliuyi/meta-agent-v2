import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePluginSchema } from "../src/main/pi/run-code/plugin-schema.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plugins = [
  {
    id: "pi.image-gen",
    entry: "packages/plugins/pi-image-gen/index.ts",
    catalog: "packages/plugins/pi-image-gen/plugin-api.json",
    reference: "packages/plugins/pi-image-gen/skills/pi-image-gen/references/api.md",
  },
  {
    id: "pi.officecli",
    entry: "packages/plugins/pi-officecli/index.ts",
    catalog: "packages/plugins/pi-officecli/plugin-api.json",
    reference: "packages/plugins/pi-officecli/skills/pi-officecli/references/api.md",
  },
  {
    id: "pi-stef.figma",
    entry: "packages/plugins/pi-stef-figma/extensions/figma.ts",
    catalog: "packages/plugins/pi-stef-figma/plugin-api.json",
    reference: "packages/plugins/pi-stef-figma/skills/pi-stef-figma/references/api.md",
  },
  {
    id: "pi.web-access",
    entry: "packages/plugins/pi-web-access-desktop/index.ts",
    catalog: "packages/plugins/pi-web-access-desktop/plugin-api.json",
    reference: "packages/plugins/pi-web-access-desktop/skills/pi-web-access/references/api.md",
  },
];

for (const plugin of plugins) {
  const module = await import(pathToFileURL(resolve(repositoryRoot, plugin.entry)).href);
  const tools = [];
  await module.default({
    registerTool(tool) {
      tools.push(tool);
    },
    getConfig() {
      return {};
    },
    on() {},
    registerCommand() {},
    sendMessage() {},
  });
  const catalog = createCatalog(plugin.id, tools);
  await writeGeneratedFiles(plugin.catalog, plugin.reference, catalog);
}

const browser = await import(
  pathToFileURL(resolve(repositoryRoot, "packages/desktop/src/main/pi/extensions/pi-browser/index.ts")).href
);
await writeReference(
  "packages/desktop/src/main/pi/extensions/pi-browser/skills/pi-browser/references/api.md",
  browser.runCodeCatalog,
);

function createCatalog(pluginId, tools) {
  return {
    schemaVersion: 1,
    pluginId,
    methods: tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: normalizePluginSchema(tool.parameters),
        result: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        concurrency: tool.executionMode === "parallel" ? "parallel" : "serial",
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function writeGeneratedFiles(catalogPath, referencePath, catalog) {
  await writeFile(resolve(repositoryRoot, catalogPath), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await writeReference(referencePath, catalog);
}

async function writeReference(path, catalog) {
  const target = resolve(repositoryRoot, path);
  const content = [
    `# ${catalog.pluginId} API`,
    "",
    "These schemas are generated from the plugin's registered Pi tools.",
    "",
    ...catalog.methods.flatMap((method) => [
      `## ${method.name}`,
      "",
      method.description,
      "",
      "```json",
      JSON.stringify(
        { parameters: method.parameters, result: method.result, concurrency: method.concurrency },
        null,
        2,
      ),
      "```",
      "",
    ]),
  ].join("\n");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
