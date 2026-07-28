import { createPublicKey, verify } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gte, lt, valid } from "semver";
import type { DesktopExtensionCapability } from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import {
  clonePluginConfigurationSchema,
  type PluginConfigurationSchema,
  parsePluginConfigurationSchema,
} from "../../shared/plugin-configuration-contracts.ts";
import type { RuntimeCompatibility } from "../../shared/sidecar-contracts.ts";
import type { ExtractedMarketplaceArchive } from "./marketplace-artifact-archive.ts";
import type { TrustedMarketplaceEndpoint } from "./marketplace-endpoint-settings-service.ts";

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

export interface VerifiedMarketplaceArtifact {
  displayName: string;
  entryPath: string;
  capabilities: DesktopExtensionCapability[];
  containsNativeCode: boolean;
  configurationSchema?: PluginConfigurationSchema;
  verifiedFiles: Array<{ path: string; sha256: string; size: number }>;
}

interface Manifest {
  schemaVersion: 1;
  marketplaceId: string;
  artifactId: string;
  plugin: { id: string; name: string; version: string; publisherId: string };
  pi: { entry: string; extensionApi: string };
  desktop: { hostProfileVersion: number; minVersion?: string; maxVersionExclusive?: string };
  target: MarketplaceArtifactTarget;
  configuration?: PluginConfigurationSchema;
  capabilities: DesktopExtensionCapability[];
  nativeModules: Array<{
    path: string;
    abi: { kind: "node"; modulesAbi: string } | { kind: "napi"; minimumNapi: string };
  }>;
  executables: Array<{ path: string; osRelease?: string; libc?: string }>;
  files: Record<string, { sha256: string; size: number; mode: "0644" | "0755" }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITIES = new Set<DesktopExtensionCapability>([
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
]);

export async function verifyMarketplaceArtifact(input: {
  stagingRoot: string;
  archive: ExtractedMarketplaceArchive;
  endpoint: TrustedMarketplaceEndpoint;
  pluginId: string;
  version: string;
  artifactId: string;
  artifactTarget: MarketplaceArtifactTarget;
  runtime: RuntimeCompatibility;
  desktopVersion: string;
}): Promise<VerifiedMarketplaceArtifact> {
  const manifestFile = input.archive.files.get("market-manifest.json");
  const signatureFile = input.archive.files.get("signature.json");
  if (!manifestFile || !signatureFile) throw new Error("Marketplace artifact metadata files are missing");
  const manifestBytes = await readFile(join(input.stagingRoot, manifestFile.path));
  const signatureBytes = await readFile(join(input.stagingRoot, signatureFile.path));
  const manifest = parseManifest(manifestBytes);
  const signature = parseSignature(signatureBytes);
  if (canonicalize(manifest) !== manifestBytes.toString("utf8")) {
    throw new Error("market-manifest.json is not canonical JSON");
  }
  if (signature.keyId !== input.endpoint.signing.keyId) throw new Error("Marketplace signing key ID changed");
  const publicKey = createPublicKey({
    key: Buffer.from(input.endpoint.signing.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, manifestBytes, publicKey, Buffer.from(signature.value, "base64"))) {
    throw new Error("Marketplace artifact signature is invalid");
  }
  if (
    manifest.marketplaceId !== input.endpoint.marketplaceId ||
    manifest.plugin.id !== input.pluginId ||
    manifest.plugin.version !== input.version ||
    manifest.artifactId !== input.artifactId
  )
    throw new Error("Marketplace artifact identity does not match the request");
  if (manifest.desktop.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
    throw new Error("Marketplace artifact host profile is incompatible");
  }
  if (!desktopVersionMatches(manifest.desktop, input.desktopVersion)) {
    throw new Error("Marketplace artifact Desktop version is incompatible");
  }
  if (!targetsEqual(manifest.target, input.artifactTarget) || !targetMatchesRuntime(manifest.target, input.runtime)) {
    throw new Error("Marketplace artifact target is incompatible");
  }
  if (manifest.configuration && !manifest.capabilities.includes("configuration.read")) {
    throw new Error("Marketplace artifact configuration requires configuration.read capability");
  }
  const expectedFiles = new Set(["market-manifest.json", "signature.json", ...Object.keys(manifest.files)]);
  if (
    expectedFiles.size !== input.archive.files.size ||
    [...input.archive.files.keys()].some((path) => !expectedFiles.has(path))
  ) {
    throw new Error("Marketplace artifact contains undeclared files");
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (!path.startsWith("payload/") || path === "payload/")
      throw new Error(`Marketplace payload path is invalid: ${path}`);
    if (!SHA256.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 0) {
      throw new Error(`Marketplace payload metadata is invalid: ${path}`);
    }
    const actual = input.archive.files.get(path);
    if (!actual || actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`Marketplace payload verification failed: ${path}`);
    }
  }
  if (!Object.hasOwn(manifest.files, manifest.pi.entry) || !manifest.pi.entry.startsWith("payload/")) {
    throw new Error("Marketplace entry is not a declared payload file");
  }
  for (const item of [...manifest.nativeModules, ...manifest.executables]) {
    if (!Object.hasOwn(manifest.files, item.path))
      throw new Error(`Marketplace native file is undeclared: ${item.path}`);
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
  for (const [path, expected] of Object.entries(manifest.files)) {
    await chmod(join(input.stagingRoot, ...path.split("/")), expected.mode === "0755" ? 0o755 : 0o644);
  }
  return {
    displayName: manifest.plugin.name,
    entryPath: resolve(input.stagingRoot, ...manifest.pi.entry.split("/")),
    capabilities: [...manifest.capabilities],
    containsNativeCode: manifest.nativeModules.length > 0 || manifest.executables.length > 0,
    ...(manifest.configuration ? { configurationSchema: clonePluginConfigurationSchema(manifest.configuration) } : {}),
    verifiedFiles: [...input.archive.files.values()].map(({ path, sha256, size }) => ({ path, sha256, size })),
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
    !value.executables.every(isExecutable) ||
    !isObject(value.files)
  )
    throw new Error("market-manifest.json is invalid");
  const files: Manifest["files"] = {};
  for (const [path, metadata] of Object.entries(value.files)) {
    if (
      !isObject(metadata) ||
      typeof metadata.sha256 !== "string" ||
      typeof metadata.size !== "number" ||
      (metadata.mode !== "0644" && metadata.mode !== "0755")
    )
      throw new Error(`Marketplace file metadata is invalid: ${path}`);
    files[path] = { sha256: metadata.sha256, size: metadata.size, mode: metadata.mode };
  }
  const configuration = parsePluginConfigurationSchema(value.configuration);
  return { ...value, ...(configuration ? { configuration } : {}), files } as Manifest;
}

function parseSignature(bytes: Buffer): { algorithm: "ed25519"; keyId: string; value: string } {
  const value = parseObject(bytes, "signature.json");
  if (value.algorithm !== "ed25519" || typeof value.keyId !== "string" || typeof value.value !== "string") {
    throw new Error("signature.json is invalid");
  }
  const decoded = Buffer.from(value.value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value.value)
    throw new Error("signature.json signature is invalid");
  return { algorithm: "ed25519", keyId: value.keyId, value: value.value };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  throw new Error("Canonical JSON contains an unsupported value");
}

function targetsEqual(left: MarketplaceArtifactTarget, right: MarketplaceArtifactTarget): boolean {
  return canonicalize(left) === canonicalize(right);
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
