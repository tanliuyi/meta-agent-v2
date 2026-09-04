import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DesktopExtensionCapability, PluginApiCatalogV1 } from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import type { PluginConfigurationSchema } from "../../shared/plugin-configuration-contracts.ts";
import { parsePluginConfigurationSchema } from "../../shared/plugin-configuration-contracts.ts";
import { parsePluginApiCatalog } from "../pi/run-code/plugin-method-registry.ts";
import { CAPABILITIES } from "../plugins/marketplace-artifact-manifest.ts";

export interface ResolvedDevelopmentEntry {
  entryPath: string;
  displayName: string;
  displayPath: string;
  capabilities: DesktopExtensionCapability[];
  configurationSchema?: PluginConfigurationSchema;
  /** 插件声明的身份（market-manifest.json plugin.id）；与市场插件同 id 时本地优先。 */
  pluginId?: string;
  skillPaths?: string[];
  runCodeSkill?: string;
  runCodeCatalogPath?: string;
  runCodeCatalogSha256?: string;
  runCodeCatalog?: PluginApiCatalogV1;
}

const ALLOWED_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const CONVENTIONAL_ENTRY_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];
const MANIFEST_FILE_NAME = "market-manifest.json";

interface DesktopDevelopmentManifest {
  plugin: { id?: string; name: string };
  pi: {
    entry: string;
    skills?: string[];
    runCode?: { skill: string; catalog: string };
  };
  capabilities: DesktopExtensionCapability[];
  configuration?: PluginConfigurationSchema;
}

/** Resolves a main-selected development entry: a regular entry file or a plugin directory. */
export async function resolveDevelopmentEntry(selectedPath: string): Promise<ResolvedDevelopmentEntry> {
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink()) throw new Error("Development extension entry must not be a symbolic link");
  if (info.isFile()) {
    if (!ALLOWED_ENTRY_EXTENSIONS.has(extname(selectedPath).toLowerCase())) {
      throw new Error("Development extension entry must be a JavaScript or TypeScript file");
    }
    const entryPath = await realpath(selectedPath);
    const name = basename(entryPath);
    return { entryPath, displayName: name, displayPath: name, capabilities: [] };
  }
  if (!info.isDirectory()) throw new Error("Development extension entry must be a regular file or directory");
  return resolveDevelopmentDirectory(selectedPath);
}

async function resolveDevelopmentDirectory(directory: string): Promise<ResolvedDevelopmentEntry> {
  let manifest: DesktopDevelopmentManifest | undefined;
  try {
    manifest = parseDesktopManifest(JSON.parse(await readFile(join(directory, MANIFEST_FILE_NAME), "utf8")));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (manifest) {
    const entryPath = await resolveManifestEntry(directory, manifest.pi.entry);
    const metadata = await resolveRunCodeMetadata(directory, manifest);
    return {
      entryPath,
      displayName: manifest.plugin.name,
      displayPath: basename(directory),
      capabilities: [...manifest.capabilities],
      ...(manifest.plugin.id ? { pluginId: manifest.plugin.id } : {}),
      ...(manifest.configuration ? { configurationSchema: manifest.configuration } : {}),
      ...(metadata.skillPaths.length > 0 ? { skillPaths: metadata.skillPaths } : {}),
      ...(metadata.runCodeSkill ? { runCodeSkill: metadata.runCodeSkill } : {}),
      ...(metadata.runCodeCatalogPath ? { runCodeCatalogPath: metadata.runCodeCatalogPath } : {}),
      ...(metadata.runCodeCatalogSha256 ? { runCodeCatalogSha256: metadata.runCodeCatalogSha256 } : {}),
      ...(metadata.runCodeCatalog ? { runCodeCatalog: metadata.runCodeCatalog } : {}),
    };
  }
  for (const candidate of CONVENTIONAL_ENTRY_NAMES) {
    const entryPath = join(directory, candidate);
    try {
      const info = await lstat(entryPath);
      if (info.isFile() && !info.isSymbolicLink()) {
        const canonical = await realpath(entryPath);
        const name = basename(directory);
        return { entryPath: canonical, displayName: name, displayPath: name, capabilities: [] };
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  throw new Error("Development extension directory has no market-manifest.json or index entry file");
}

async function resolveManifestEntry(directory: string, entry: string): Promise<string> {
  if (isAbsolute(entry)) throw new Error("market-manifest.json pi.entry must be relative to the plugin directory");
  const resolved = resolve(directory, entry);
  const withinRoot = relative(directory, resolved);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error("market-manifest.json pi.entry escapes the plugin directory");
  }
  if (!ALLOWED_ENTRY_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    throw new Error("market-manifest.json pi.entry must be a JavaScript or TypeScript file");
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error("market-manifest.json pi.entry file is missing");
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("market-manifest.json pi.entry is not a regular non-symlink file");
  }
  return realpath(resolved);
}

function parseDesktopManifest(value: unknown): DesktopDevelopmentManifest {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    throw new Error("market-manifest.json schema is unsupported");
  }
  const desktop = value.desktop;
  if (!isPlainObject(desktop) || desktop.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
    throw new Error(
      `market-manifest.json host profile must be ${DESKTOP_EXTENSION_HOST_PROFILE_VERSION} (desktop.hostProfileVersion)`,
    );
  }
  const plugin = value.plugin;
  if (!isPlainObject(plugin) || typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("market-manifest.json plugin.name is missing");
  }
  if (plugin.id !== undefined && (typeof plugin.id !== "string" || !plugin.id.trim() || plugin.id.length > 200)) {
    throw new Error("market-manifest.json plugin.id is invalid");
  }
  const pi = value.pi;
  if (!isPlainObject(pi) || typeof pi.entry !== "string" || !pi.entry.trim()) {
    throw new Error("market-manifest.json pi.entry is missing");
  }
  const capabilities = parseCapabilities(value.capabilities);
  const configuration = parsePluginConfigurationSchema(value.configuration);
  if (configuration && !capabilities.includes("configuration.read")) {
    throw new Error("market-manifest.json configuration requires the configuration.read capability");
  }
  const skills = parseRelativePaths(pi.skills, "pi.skills");
  const runCode = parseRunCode(pi.runCode);
  if (capabilities.includes("plugin-methods.provide") && (!runCode || skills.length === 0 || !plugin.id)) {
    throw new Error("market-manifest.json plugin methods require plugin.id, pi.skills and pi.runCode");
  }
  return {
    plugin: { ...(plugin.id ? { id: plugin.id.trim() } : {}), name: plugin.name.trim() },
    pi: { entry: pi.entry, ...(skills.length > 0 ? { skills } : {}), ...(runCode ? { runCode } : {}) },
    capabilities,
    ...(configuration ? { configuration } : {}),
  };
}

function parseRelativePaths(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length !== new Set(value).size) throw new Error(`${field} is invalid`);
  for (const item of value) {
    if (typeof item !== "string" || !item || isAbsolute(item) || item.split(/[\\/]/).includes("..")) {
      throw new Error(`${field} contains an invalid path`);
    }
  }
  return value as string[];
}

function parseRunCode(value: unknown): { skill: string; catalog: string } | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainObject(value) ||
    typeof value.skill !== "string" ||
    !value.skill ||
    typeof value.catalog !== "string" ||
    !value.catalog
  ) {
    throw new Error("market-manifest.json pi.runCode is invalid");
  }
  parseRelativePaths([value.catalog], "pi.runCode.catalog");
  return { skill: value.skill, catalog: value.catalog };
}

async function resolveRunCodeMetadata(
  directory: string,
  manifest: DesktopDevelopmentManifest,
): Promise<{
  skillPaths: string[];
  runCodeSkill?: string;
  runCodeCatalogPath?: string;
  runCodeCatalogSha256?: string;
  runCodeCatalog?: PluginApiCatalogV1;
}> {
  const skillPaths: string[] = [];
  for (const skill of manifest.pi.skills ?? []) {
    if (!skill.endsWith("/SKILL.md") && skill !== "SKILL.md") throw new Error("pi.skills entries must name SKILL.md");
    skillPaths.push(await resolveManifestResource(directory, skill));
  }
  if (!manifest.pi.runCode) return { skillPaths };
  const runCodeCatalogPath = await resolveManifestResource(directory, manifest.pi.runCode.catalog);
  const bytes = await readFile(runCodeCatalogPath);
  if (bytes.byteLength > 256 * 1024) throw new Error("plugin-api.json exceeds 256 KiB");
  let parsedCatalog: unknown;
  try {
    parsedCatalog = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("plugin-api.json syntax is invalid");
  }
  let runCodeCatalog: PluginApiCatalogV1;
  try {
    runCodeCatalog = parsePluginApiCatalog(parsedCatalog) as unknown as PluginApiCatalogV1;
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`plugin-api.json schema is invalid${reason}`);
  }
  if (runCodeCatalog.pluginId !== manifest.plugin.id) {
    throw new Error("plugin-api.json pluginId does not match manifest plugin.id");
  }
  return {
    skillPaths,
    runCodeSkill: manifest.pi.runCode.skill,
    runCodeCatalogPath,
    runCodeCatalogSha256: createHash("sha256").update(bytes).digest("hex"),
    runCodeCatalog,
  };
}

async function resolveManifestResource(directory: string, path: string): Promise<string> {
  const resolved = resolve(directory, path);
  const withinRoot = relative(directory, resolved);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot))
    throw new Error("manifest resource escapes plugin directory");
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("manifest resource must be a regular non-symlink file");
  return realpath(resolved);
}

function parseCapabilities(value: unknown): DesktopExtensionCapability[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const capabilities: DesktopExtensionCapability[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !CAPABILITIES.has(item as DesktopExtensionCapability)) {
      throw new Error(`market-manifest.json declares an unsupported capability: ${String(item)}`);
    }
    if (seen.has(item)) throw new Error(`market-manifest.json capability is duplicated: ${item}`);
    seen.add(item);
    capabilities.push(item as DesktopExtensionCapability);
  }
  return capabilities;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
