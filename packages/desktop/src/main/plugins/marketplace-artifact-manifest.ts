import { createHash } from "node:crypto";
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gte, lt, valid } from "semver";
import type { DesktopExtensionCapability, PluginApiCatalogV1 } from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import {
  clonePluginConfigurationSchema,
  type PluginConfigurationSchema,
  parsePluginConfigurationSchema,
} from "../../shared/plugin-configuration-contracts.ts";
import type { RuntimeCompatibility } from "../../shared/sidecar-contracts.ts";
import { parsePluginApiCatalog } from "../pi/run-code/plugin-method-registry.ts";
import type { ExtractedMarketplaceArchive } from "./marketplace-artifact-archive.ts";

export interface MarketplaceArtifactTarget {
  platform: string;
  arch: string;
  nodeVersion?: string;
  modulesAbi?: string;
  minimumNapi?: string;
  osRelease?: string;
  libc?: string;
  toolchain?: string;
  piVersion?: string;
  runtimeCompatibilityId?: string;
}

export interface MarketplaceArtifactManifestResult {
  displayName: string;
  entryPath: string;
  capabilities: DesktopExtensionCapability[];
  containsNativeCode: boolean;
  configurationSchema?: PluginConfigurationSchema;
  skillPaths: string[];
  runCodeSkill?: string;
  runCodeCatalogPath?: string;
  runCodeCatalogSha256?: string;
  runCodeCatalog?: PluginApiCatalogV1;
}

interface Manifest {
  schemaVersion: 1;
  marketplaceId: string;
  artifactId: string;
  plugin: { id: string; name: string; version: string; publisherId: string };
  pi: {
    entry: string;
    extensionApi: string;
    skills?: string[];
    runCode?: { skill: string; catalog: string };
  };
  desktop: { hostProfileVersion: number; minVersion?: string; maxVersionExclusive?: string };
  target: MarketplaceArtifactTarget;
  configuration?: PluginConfigurationSchema;
  capabilities: DesktopExtensionCapability[];
  nativeModules: Array<{
    path: string;
    abi: { kind: "node"; modulesAbi: string } | { kind: "napi"; minimumNapi: string };
  }>;
  executables: Array<{ path: string; osRelease?: string; libc?: string }>;
  files: Record<string, { mode?: "0644" | "0755" }>;
}

export const CAPABILITIES = new Set<DesktopExtensionCapability>([
  "events.subscribe",
  "configuration.read",
  "tools.register",
  "commands.register",
  "providers.register",
  "messages.enqueue",
  "messages.custom",
  "session.read",
  "session.abort",
  "session.compact",
  "session.reload",
  "session.replace",
  "ui.notify",
  "ui.dialog",
  "ui.status",
  "ui.widget.text",
  "ui.title",
  "ui.composer.write",
  "ui.composer.read",
  "ui.working",
  "ui.tui.custom",
  "ui.tui.theme",
  "ui.tui.chrome",
  "ui.tui.editor",
  "ui.terminal.input",
  "plugin-methods.provide",
]);

export async function readMarketplaceArtifactManifest(input: {
  stagingRoot: string;
  archive: ExtractedMarketplaceArchive;
  pluginId: string;
  version: string;
  artifactId: string;
  runtime: RuntimeCompatibility;
  desktopVersion: string;
  marketplaceId: string;
}): Promise<MarketplaceArtifactManifestResult> {
  const manifestFile = input.archive.files.get("market-manifest.json");
  if (!manifestFile) throw new Error("Marketplace artifact manifest is missing");
  const manifest = parseManifest(await readFile(join(input.stagingRoot, manifestFile.path)));
  if (
    manifest.marketplaceId !== input.marketplaceId ||
    manifest.plugin.id !== input.pluginId ||
    manifest.plugin.version !== input.version ||
    manifest.artifactId !== input.artifactId
  ) {
    throw new Error("Marketplace artifact identity does not match the request");
  }
  if (manifest.desktop.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
    throw new Error("Marketplace artifact host profile is incompatible");
  }
  if (!desktopVersionMatches(manifest.desktop, input.desktopVersion)) {
    throw new Error("Marketplace artifact Desktop version is incompatible");
  }
  if (!targetMatchesRuntime(manifest.target, input.runtime)) {
    throw new Error("Marketplace artifact target is incompatible");
  }
  if (manifest.configuration && !manifest.capabilities.includes("configuration.read")) {
    throw new Error("Marketplace artifact configuration requires configuration.read capability");
  }
  if (!manifest.pi.entry.startsWith("payload/") || !input.archive.files.has(manifest.pi.entry)) {
    throw new Error("Marketplace entry is not present in the payload");
  }
  for (const item of [...manifest.nativeModules, ...manifest.executables]) {
    if (!input.archive.files.has(item.path)) throw new Error(`Marketplace native file is missing: ${item.path}`);
  }
  for (const item of manifest.nativeModules) {
    const compatible =
      item.abi.kind === "node"
        ? item.abi.modulesAbi === input.runtime.modulesAbi
        : minimumNapiMatches(item.abi.minimumNapi, input.runtime.napi);
    if (!compatible) throw new Error(`Marketplace native module ABI is incompatible: ${item.path}`);
  }
  for (const executable of manifest.executables) {
    if (
      (executable.osRelease !== undefined && executable.osRelease !== input.runtime.osRelease) ||
      (executable.libc !== undefined && executable.libc !== input.runtime.libc)
    ) {
      throw new Error(`Marketplace executable target is incompatible: ${executable.path}`);
    }
  }
  for (const [path, metadata] of Object.entries(manifest.files)) {
    if (metadata.mode === "0755" && input.archive.files.has(path)) {
      await chmod(join(input.stagingRoot, ...path.split("/")), 0o755);
    }
  }
  const runCode = await validateRunCodeMetadata(manifest, input.stagingRoot, input.archive);
  return {
    displayName: manifest.plugin.name,
    entryPath: resolve(input.stagingRoot, ...manifest.pi.entry.split("/")),
    capabilities: [...manifest.capabilities],
    containsNativeCode: manifest.nativeModules.length > 0 || manifest.executables.length > 0,
    skillPaths: runCode.skillPaths,
    ...(runCode.skill ? { runCodeSkill: runCode.skill } : {}),
    ...(runCode.catalogPath ? { runCodeCatalogPath: runCode.catalogPath } : {}),
    ...(runCode.catalogSha256 ? { runCodeCatalogSha256: runCode.catalogSha256 } : {}),
    ...(runCode.catalog ? { runCodeCatalog: runCode.catalog } : {}),
    ...(manifest.configuration ? { configurationSchema: clonePluginConfigurationSchema(manifest.configuration) } : {}),
  };
}

export function targetMatchesRuntime(target: MarketplaceArtifactTarget, runtime: RuntimeCompatibility): boolean {
  const required: Array<[unknown, unknown]> = [
    [target.nodeVersion, runtime.nodeVersion],
    [target.modulesAbi, runtime.modulesAbi],
    [target.osRelease, runtime.osRelease],
    [target.libc, runtime.libc],
    [target.toolchain, runtime.toolchain],
    [target.piVersion, runtime.piVersion],
    [target.runtimeCompatibilityId, runtime.runtimeCompatibilityId],
  ];
  const platformMatches = target.platform === "universal" || target.platform === runtime.platform;
  const archMatches = target.arch === "universal" || target.arch === runtime.arch;
  const napiMatches = target.minimumNapi === undefined || minimumNapiMatches(target.minimumNapi, runtime.napi);
  return (
    platformMatches &&
    archMatches &&
    napiMatches &&
    required.every(([expected, actual]) => expected === undefined || expected === actual)
  );
}

function parseManifest(bytes: Buffer): Manifest {
  const value = parseObject(bytes, "market-manifest.json");
  if (
    value.schemaVersion !== 1 ||
    typeof value.marketplaceId !== "string" ||
    typeof value.artifactId !== "string" ||
    !isObject(value.plugin) ||
    typeof value.plugin.id !== "string" ||
    typeof value.plugin.name !== "string" ||
    typeof value.plugin.version !== "string" ||
    typeof value.plugin.publisherId !== "string" ||
    !isObject(value.pi) ||
    typeof value.pi.entry !== "string" ||
    typeof value.pi.extensionApi !== "string" ||
    !optionalStringArray(value.pi.skills) ||
    !optionalRunCode(value.pi.runCode) ||
    !isObject(value.desktop) ||
    typeof value.desktop.hostProfileVersion !== "number" ||
    !optionalString(value.desktop.minVersion) ||
    !optionalString(value.desktop.maxVersionExclusive) ||
    !isArtifactTarget(value.target) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) => typeof capability === "string" && CAPABILITIES.has(capability as DesktopExtensionCapability),
    ) ||
    !Array.isArray(value.nativeModules) ||
    !value.nativeModules.every(isNativeModule) ||
    !Array.isArray(value.executables) ||
    !value.executables.every(isExecutable)
  ) {
    throw new Error("market-manifest.json is invalid");
  }
  const files: Manifest["files"] = {};
  if (value.files !== undefined) {
    if (!isObject(value.files)) throw new Error("Marketplace file metadata is invalid");
    for (const [path, metadata] of Object.entries(value.files)) {
      if (
        !isObject(metadata) ||
        (metadata.mode !== undefined && metadata.mode !== "0644" && metadata.mode !== "0755")
      ) {
        throw new Error(`Marketplace file metadata is invalid: ${path}`);
      }
      files[path] = metadata.mode === undefined ? {} : { mode: metadata.mode };
    }
  }
  const configuration = parsePluginConfigurationSchema(value.configuration);
  return { ...value, ...(configuration ? { configuration } : {}), files } as Manifest;
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length === new Set(value).size &&
      value.every((item) => typeof item === "string" && item.length > 0))
  );
}

function optionalRunCode(value: unknown): value is { skill: string; catalog: string } | undefined {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.skill === "string" &&
      value.skill.length > 0 &&
      typeof value.catalog === "string" &&
      value.catalog.length > 0)
  );
}

async function validateRunCodeMetadata(
  manifest: Manifest,
  stagingRoot: string,
  archive: ExtractedMarketplaceArchive,
): Promise<{
  skillPaths: string[];
  skill?: string;
  catalogPath?: string;
  catalogSha256?: string;
  catalog?: PluginApiCatalogV1;
}> {
  const skills = manifest.pi.skills ?? [];
  const runCode = manifest.pi.runCode;
  if (manifest.capabilities.includes("plugin-methods.provide") && (!runCode || skills.length === 0)) {
    throw new Error("Marketplace plugin-methods.provide requires skills and primary runCode skill/catalog");
  }
  const skillPaths: string[] = [];
  for (const skill of skills) {
    if (!skill.startsWith("payload/") || !skill.endsWith("/SKILL.md") || !archive.files.has(skill))
      throw new Error(`Marketplace skill is invalid: ${skill}`);
    const path = await realpath(resolve(stagingRoot, ...skill.split("/")));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Marketplace skill is not a regular file: ${skill}`);
    skillPaths.push(path);
  }
  if (!runCode) return { skillPaths };
  if (!runCode.catalog.startsWith("payload/") || !archive.files.has(runCode.catalog))
    throw new Error("Marketplace plugin catalog is invalid");
  const catalogPath = await realpath(resolve(stagingRoot, ...runCode.catalog.split("/")));
  const info = await lstat(catalogPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Marketplace plugin catalog is not a regular file");
  let catalog: PluginApiCatalogV1;
  let catalogBytes: Buffer;
  try {
    catalogBytes = await readFile(catalogPath);
    if (catalogBytes.byteLength > 256 * 1024) throw new Error("catalog exceeds 256 KiB");
    catalog = parsePluginApiCatalog(JSON.parse(catalogBytes.toString("utf8"))) as unknown as PluginApiCatalogV1;
  } catch {
    throw new Error("Marketplace plugin catalog is invalid JSON");
  }
  if (catalog.pluginId !== manifest.plugin.id) throw new Error("Marketplace plugin catalog identity does not match");
  const catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
  return { skillPaths, skill: runCode.skill, catalogPath, catalogSha256, catalog } as {
    skillPaths: string[];
    skill?: string;
    catalogPath?: string;
    catalogSha256?: string;
    catalog?: PluginApiCatalogV1;
  };
}

function desktopVersionMatches(desktop: Manifest["desktop"], desktopVersion: string): boolean {
  if (!valid(desktopVersion)) return false;
  if (desktop.minVersion !== undefined && (!valid(desktop.minVersion) || !gte(desktopVersion, desktop.minVersion))) {
    return false;
  }
  if (
    desktop.maxVersionExclusive !== undefined &&
    (!valid(desktop.maxVersionExclusive) || !lt(desktopVersion, desktop.maxVersionExclusive))
  ) {
    return false;
  }
  return true;
}

function minimumNapiMatches(minimumNapi: string, actualNapi: string): boolean {
  if (!/^[1-9]\d*$/.test(minimumNapi) || !/^[1-9]\d*$/.test(actualNapi)) return false;
  const minimum = Number(minimumNapi);
  const actual = Number(actualNapi);
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(actual) && actual >= minimum;
}

function isArtifactTarget(value: unknown): value is MarketplaceArtifactTarget {
  if (!isObject(value) || typeof value.platform !== "string" || typeof value.arch !== "string") return false;
  return [
    value.nodeVersion,
    value.modulesAbi,
    value.minimumNapi,
    value.osRelease,
    value.libc,
    value.toolchain,
    value.piVersion,
    value.runtimeCompatibilityId,
  ].every(optionalString);
}

function isNativeModule(value: unknown): value is Manifest["nativeModules"][number] {
  if (!isObject(value) || typeof value.path !== "string" || !isObject(value.abi)) return false;
  return value.abi.kind === "node"
    ? typeof value.abi.modulesAbi === "string"
    : value.abi.kind === "napi" && typeof value.abi.minimumNapi === "string";
}

function isExecutable(value: unknown): value is Manifest["executables"][number] {
  return (
    isObject(value) && typeof value.path === "string" && optionalString(value.osRelease) && optionalString(value.libc)
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} JSON syntax invalid`);
  }
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
