import { createHash, type Hash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { valid } from "semver";
import type {
  ApplyMarketplaceMutationTarget,
  InstallMarketplacePluginInput,
  InstallMarketplacePluginResult,
  UninstallMarketplacePluginInput,
  UninstallMarketplacePluginResult,
  UpdateMarketplacePluginInput,
  UpdateMarketplacePluginResult,
} from "../../shared/plugin-marketplace-contracts.ts";
import type { RuntimeCompatibility } from "../../shared/sidecar-contracts.ts";
import { durablyFlushMarketplaceArchive, extractMarketplaceArchive } from "./marketplace-artifact-archive.ts";
import {
  type MarketplaceArtifactTarget,
  readMarketplaceArtifactManifest,
  targetMatchesRuntime,
} from "./marketplace-artifact-manifest.ts";
import type { MarketplaceEndpointSettingsService } from "./marketplace-endpoint-settings-service.ts";
import { appendMarketplaceRuntimeQuery, readBoundedJsonResponse } from "./marketplace-http.ts";
import {
  isMarketplacePluginOwned,
  markMarketplaceVersionInactive,
  validateInstalledMarketplacePlugin,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "./marketplace-installed-plugin.ts";
import { withMarketplacePluginLock } from "./marketplace-plugin-lock.ts";
import type { InstalledMarketplacePluginRecord, MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

interface ArtifactMetadata {
  id: string;
  target: MarketplaceArtifactTarget;
  sha256: string;
  size: number;
  containsNativeCode: boolean;
  preferred: boolean;
  downloadEndpoint: string;
}
interface DownloadMetadata {
  pluginId: string;
  version: string;
  artifactId: string;
  url: string;
  sha256: string;
  size: number;
}
interface InstallerOptions {
  fetch?: typeof fetch;
  createId?(): string;
  now?(): number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  maxArtifactBytes?: number;
  reservedExtensionIds?: ReadonlySet<string>;
  /** Test seam: invoked after the version payload landed and before the registry commit. */
  beforeRegistryCommit?(rootPath: string): Promise<void>;
}

const PLUGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const REQUEST_ID = /^[a-zA-Z0-9._-]{1,128}$/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETED_MUTATIONS = 256;

/**
 * Installs, updates and uninstalls marketplace plugins.
 *
 * Crash recovery is intentionally file-level: the registry is the single commit
 * point, version payloads land by atomic rename before the registry commit, and
 * the startup reconciler validates or repairs projections afterwards. There is
 * no durable apply journal.
 */
export class MarketplacePluginInstaller {
  private readonly endpoints: MarketplaceEndpointSettingsService;
  private readonly registry: MarketplacePluginRegistry;
  private readonly lockDirectory: string;
  private readonly marketplaceRoot: string;
  private readonly desktopVersion: string;
  private readonly runtime: RuntimeCompatibility;
  private readonly fetchImpl: typeof fetch;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxArtifactBytes: number;
  private readonly reservedExtensionIds: ReadonlySet<string>;
  private readonly beforeRegistryCommit?: (rootPath: string) => Promise<void>;
  private readonly completedInstalls = new CompletedMutationMap<InstallMarketplacePluginResult>();
  private readonly completedUpdates = new CompletedMutationMap<UpdateMarketplacePluginResult>();
  private readonly completedUninstalls = new CompletedMutationMap<UninstallMarketplacePluginResult>();

  constructor(
    endpoints: MarketplaceEndpointSettingsService,
    registry: MarketplacePluginRegistry,
    lockDirectory: string,
    marketplaceRoot: string,
    desktopVersion: string,
    runtime: RuntimeCompatibility,
    options: InstallerOptions = {},
  ) {
    this.endpoints = endpoints;
    this.registry = registry;
    this.lockDirectory = lockDirectory;
    this.marketplaceRoot = marketplaceRoot;
    this.desktopVersion = desktopVersion;
    this.runtime = runtime;
    this.fetchImpl = options.fetch ?? fetch;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 128 * 1024 * 1024;
    this.reservedExtensionIds = options.reservedExtensionIds ?? new Set();
    this.beforeRegistryCommit = options.beforeRegistryCommit;
  }

  install(input: InstallMarketplacePluginInput): Promise<InstallMarketplacePluginResult> {
    return withMarketplacePluginLock(this.lockDirectory, input.pluginId, () => this.installSerialized(input));
  }

  update(input: UpdateMarketplacePluginInput): Promise<UpdateMarketplacePluginResult> {
    return withMarketplacePluginLock(this.lockDirectory, input.pluginId, () => this.updateSerialized(input));
  }

  uninstall(input: UninstallMarketplacePluginInput): Promise<UninstallMarketplacePluginResult> {
    return withMarketplacePluginLock(this.lockDirectory, input.pluginId, () => this.uninstallSerialized(input));
  }

  clearCompletedMutation(requestId: string): void {
    this.completedInstalls.delete(requestId);
    this.completedUpdates.delete(requestId);
    this.completedUninstalls.delete(requestId);
  }

  private async installSerialized(input: InstallMarketplacePluginInput): Promise<InstallMarketplacePluginResult> {
    const cached = this.completedInstalls.get(input.requestId);
    if (cached) return cached;
    if (
      !REQUEST_ID.test(input.requestId) ||
      input.pluginId.length > 200 ||
      !PLUGIN_ID.test(input.pluginId) ||
      !valid(input.version) ||
      input.confirmFullTrust !== true ||
      !isApplyTarget(input.applyToCurrentSession)
    ) {
      throw new Error("Marketplace install input is invalid");
    }
    if (this.reservedExtensionIds.has(input.pluginId)) {
      throw new Error(`Marketplace plugin ID conflicts with a Desktop-managed extension: ${input.pluginId}`);
    }
    const initial = await this.registry.getSnapshot();
    if (initial.revision !== input.expectedRevision) return { status: "conflict", current: initial };
    if (initial.plugins.some((plugin) => plugin.id === input.pluginId)) {
      const result = {
        status: "already-installed",
        snapshot: initial,
      } as const;
      this.completedInstalls.set(input.requestId, result);
      return result;
    }

    const endpoint = await this.endpoints.getActiveEndpoint();
    const artifact = await this.selectArtifact(endpoint.apiRoot, input.pluginId, input.version);
    const download = await this.getDownloadMetadata(endpoint.apiRoot, artifact, input.pluginId, input.version);
    const artifactUrl = validateArtifactUrl(download.url);
    const rootPath = join(this.marketplaceRoot, input.pluginId);
    const versionPath = join(rootPath, ".versions", artifact.sha256);
    const stagingPath = createStagingPath(this.marketplaceRoot, input.pluginId, this.createId());
    await prepareStagingPath(stagingPath);
    let rootCreated = false;
    let versionCreated = false;
    let registryCommitted = false;
    try {
      const archive = await this.downloadAndExtract(artifactUrl, artifact, stagingPath);
      if (archive.compressedBytes !== artifact.size)
        throw new Error("Marketplace artifact size does not match metadata");
      const verified = await readMarketplaceArtifactManifest({
        stagingRoot: stagingPath,
        archive,
        marketplaceId: endpoint.marketplaceId,
        pluginId: input.pluginId,
        version: input.version,
        artifactId: artifact.id,
        runtime: this.runtime,
        desktopVersion: this.desktopVersion,
      });
      await durablyFlushMarketplaceArchive(stagingPath);
      rootCreated = await prepareInstallRoot(rootPath);
      const entryRelative = relative(stagingPath, verified.entryPath);
      const entryPath = resolve(versionPath, entryRelative);
      const record: InstalledMarketplacePluginRecord = {
        id: input.pluginId,
        displayName: verified.displayName,
        marketplaceId: endpoint.marketplaceId,
        version: input.version,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        enabled: true,
        capabilities: verified.capabilities,
        containsNativeCode: verified.containsNativeCode || artifact.containsNativeCode,
        ...(verified.configurationSchema ? { configurationSchema: verified.configurationSchema } : {}),
        ...(verified.skillPaths.length > 0
          ? { skillPaths: verified.skillPaths.map((path) => path.replace(stagingPath, versionPath)) }
          : {}),
        ...(verified.pluginCallSkill ? { pluginCallSkill: verified.pluginCallSkill } : {}),
        ...(verified.pluginCallCatalogPath
          ? { pluginCallCatalogPath: verified.pluginCallCatalogPath.replace(stagingPath, versionPath) }
          : {}),
        ...(verified.pluginCallCatalogSha256 ? { pluginCallCatalogSha256: verified.pluginCallCatalogSha256 } : {}),
        ...(verified.pluginCallCatalog ? { pluginCallCatalog: verified.pluginCallCatalog } : {}),
        state: "installed",
        installedAt: this.now(),
        scope: "global",
        entryPath,
        rootPath,
      };
      const versionExists = await pathExists(versionPath);
      if (versionExists) await validateInstalledMarketplacePlugin(record, this.marketplaceRoot);
      await mkdir(rootPath, { recursive: true, mode: 0o700 });
      await mkdir(dirname(versionPath), { recursive: true, mode: 0o700 });
      if (versionExists) {
        await rm(stagingPath, { recursive: true, force: true });
      } else {
        await rename(stagingPath, versionPath);
        versionCreated = true;
      }
      await syncDirectory(dirname(stagingPath));
      await syncDirectory(dirname(versionPath));
      await syncDirectory(rootPath);
      if (rootCreated) await syncDirectory(dirname(rootPath));
      await this.beforeRegistryCommit?.(rootPath);
      const saved = await this.registry.commitInstall(input.expectedRevision, record);
      if (saved.status === "conflict" || saved.status === "already-installed") {
        await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, rootCreated);
        return saved.status === "conflict"
          ? { status: "conflict", current: saved.snapshot }
          : { status: "already-installed", snapshot: saved.snapshot };
      }
      registryCommitted = true;
      await writeMarketplaceProjection(record);
      const result: InstallMarketplacePluginResult = {
        status: "installed",
        snapshot: saved.snapshot,
      };
      this.completedInstalls.set(input.requestId, result);
      return result;
    } catch (error) {
      if (!registryCommitted) {
        registryCommitted = await this.registryPointsTo(input.pluginId, artifact.sha256);
      }
      if (registryCommitted) {
        const result: InstallMarketplacePluginResult = {
          status: "installed",
          snapshot: await this.registry.getSnapshot(),
          recoveryPending: true,
        };
        this.completedInstalls.set(input.requestId, result);
        return result;
      }
      await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, rootCreated);
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async updateSerialized(input: UpdateMarketplacePluginInput): Promise<UpdateMarketplacePluginResult> {
    const cached = this.completedUpdates.get(input.requestId);
    if (cached) return cached;
    if (
      !REQUEST_ID.test(input.requestId) ||
      input.pluginId.length > 200 ||
      !PLUGIN_ID.test(input.pluginId) ||
      !valid(input.version) ||
      input.confirmFullTrust !== true ||
      !isApplyTarget(input.applyToCurrentSession)
    ) {
      throw new Error("Marketplace update input is invalid");
    }
    const initial = await this.registry.getInternalSnapshot();
    if (initial.revision !== input.expectedRevision) {
      return { status: "conflict", current: await this.registry.getSnapshot() };
    }
    const before = initial.plugins.find((plugin) => plugin.id === input.pluginId);
    if (!before) {
      const result = {
        status: "not-installed",
        snapshot: await this.registry.getSnapshot(),
      } as const;
      this.completedUpdates.set(input.requestId, result);
      return result;
    }
    if (before.state === "broken") {
      throw new Error("Broken marketplace plugins must be uninstalled before reinstalling");
    }
    await validateInstalledMarketplacePlugin(before, this.marketplaceRoot);
    if (before.version === input.version) {
      const result = {
        status: "same-version",
        snapshot: await this.registry.getSnapshot(),
      } as const;
      this.completedUpdates.set(input.requestId, result);
      return result;
    }
    const endpoint = await this.endpoints.getActiveEndpoint();
    const artifact = await this.selectArtifact(endpoint.apiRoot, input.pluginId, input.version);
    const download = await this.getDownloadMetadata(endpoint.apiRoot, artifact, input.pluginId, input.version);
    const artifactUrl = validateArtifactUrl(download.url);
    const rootPath = before.rootPath;
    const versionPath = join(rootPath, ".versions", artifact.sha256);
    const stagingPath = createStagingPath(this.marketplaceRoot, input.pluginId, this.createId());
    await prepareStagingPath(stagingPath);
    let versionCreated = false;
    let registryCommitted = false;
    try {
      const archive = await this.downloadAndExtract(artifactUrl, artifact, stagingPath);
      if (archive.compressedBytes !== artifact.size) {
        throw new Error("Marketplace artifact size does not match metadata");
      }
      const verified = await readMarketplaceArtifactManifest({
        stagingRoot: stagingPath,
        archive,
        marketplaceId: endpoint.marketplaceId,
        pluginId: input.pluginId,
        version: input.version,
        artifactId: artifact.id,
        runtime: this.runtime,
        desktopVersion: this.desktopVersion,
      });
      await durablyFlushMarketplaceArchive(stagingPath);
      const entryRelative = relative(stagingPath, verified.entryPath);
      const after: InstalledMarketplacePluginRecord = {
        ...before,
        displayName: verified.displayName,
        version: input.version,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        capabilities: verified.capabilities,
        containsNativeCode: verified.containsNativeCode || artifact.containsNativeCode,
        configurationSchema: verified.configurationSchema,
        skillPaths: verified.skillPaths.map((path) => path.replace(stagingPath, versionPath)),
        ...(verified.pluginCallSkill ? { pluginCallSkill: verified.pluginCallSkill } : {}),
        ...(verified.pluginCallCatalogPath
          ? { pluginCallCatalogPath: verified.pluginCallCatalogPath.replace(stagingPath, versionPath) }
          : {}),
        ...(verified.pluginCallCatalogSha256 ? { pluginCallCatalogSha256: verified.pluginCallCatalogSha256 } : {}),
        ...(verified.pluginCallCatalog ? { pluginCallCatalog: verified.pluginCallCatalog } : {}),
        state: "installed",
        enabled: true,
        installedAt: this.now(),
        entryPath: resolve(versionPath, entryRelative),
      };
      const versionExists = await pathExists(versionPath);
      if (versionExists) await validateInstalledMarketplacePlugin(after, this.marketplaceRoot);
      if (versionExists) {
        await rm(stagingPath, { recursive: true, force: true });
      } else {
        await rename(stagingPath, versionPath);
        versionCreated = true;
      }
      await syncDirectory(dirname(stagingPath));
      await syncDirectory(dirname(versionPath));
      await syncDirectory(rootPath);
      await this.beforeRegistryCommit?.(rootPath);
      const saved = await this.registry.commitUpdate(input.expectedRevision, before.artifactHash, after);
      if (saved.status !== "saved") {
        await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, false);
        if (saved.status === "conflict") return { status: "conflict", current: saved.snapshot };
        const result = {
          status: "not-installed",
          snapshot: saved.snapshot,
        } as const;
        this.completedUpdates.set(input.requestId, result);
        return result;
      }
      registryCommitted = true;
      await markMarketplaceVersionInactive(before, this.now());
      await writeMarketplaceProjection(after);
      const result = {
        status: "updated",
        snapshot: saved.snapshot,
        reloadRequired: true,
      } as const;
      this.completedUpdates.set(input.requestId, result);
      return result;
    } catch (error) {
      if (!registryCommitted) {
        registryCommitted = await this.registryPointsTo(input.pluginId, artifact.sha256);
      }
      if (registryCommitted) {
        const result: UpdateMarketplacePluginResult = {
          status: "updated",
          snapshot: await this.registry.getSnapshot(),
          reloadRequired: true,
          recoveryPending: true,
        };
        this.completedUpdates.set(input.requestId, result);
        return result;
      }
      await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, false);
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async uninstallSerialized(input: UninstallMarketplacePluginInput): Promise<UninstallMarketplacePluginResult> {
    const cached = this.completedUninstalls.get(input.requestId);
    if (cached) return cached;
    if (
      !REQUEST_ID.test(input.requestId) ||
      input.pluginId.length > 200 ||
      !PLUGIN_ID.test(input.pluginId) ||
      input.confirmRemoval !== true ||
      !isApplyTarget(input.applyToCurrentSession)
    ) {
      throw new Error("Marketplace uninstall input is invalid");
    }
    const initial = await this.registry.getInternalSnapshot();
    if (initial.revision !== input.expectedRevision) {
      return { status: "conflict", current: await this.registry.getSnapshot() };
    }
    const record = initial.plugins.find((plugin) => plugin.id === input.pluginId);
    if (!record) {
      const result = {
        status: "not-installed",
        snapshot: await this.registry.getSnapshot(),
      } as const;
      this.completedUninstalls.set(input.requestId, result);
      return result;
    }
    const owned = await isMarketplacePluginOwned(record);
    const saved = await this.registry.commitUninstall(input.expectedRevision, input.pluginId);
    if (saved.status === "conflict") return { status: "conflict", current: saved.snapshot };
    if (saved.status === "not-installed") {
      const result = {
        status: "not-installed",
        snapshot: saved.snapshot,
      } as const;
      this.completedUninstalls.set(input.requestId, result);
      return result;
    }
    if (owned) {
      try {
        const uninstalledAt = this.now();
        await markMarketplaceVersionInactive(record, uninstalledAt);
        await writeMarketplaceUninstallTombstone(record, `uninstall-${input.requestId}`, uninstalledAt);
      } catch {
        const result = {
          status: "uninstalled",
          snapshot: saved.snapshot,
          reloadRequired: true,
          recoveryPending: true,
        } as const;
        this.completedUninstalls.set(input.requestId, result);
        return result;
      }
    }
    const result = {
      status: "uninstalled",
      snapshot: saved.snapshot,
      reloadRequired: true,
    } as const;
    this.completedUninstalls.set(input.requestId, result);
    return result;
  }

  private async registryPointsTo(pluginId: string, artifactHash: string): Promise<boolean> {
    return (await this.registry.getInternalSnapshot()).plugins.some(
      (plugin) => plugin.id === pluginId && plugin.artifactHash === artifactHash,
    );
  }

  private async selectArtifact(apiRoot: string, pluginId: string, version: string): Promise<ArtifactMetadata> {
    const url = new URL(
      `plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/artifacts`,
      apiRoot,
    );
    url.searchParams.set("desktopVersion", this.desktopVersion);
    appendMarketplaceRuntimeQuery(url, this.runtime);
    const artifacts = parseArtifacts(await this.requestJson(url, "Marketplace artifacts response"));
    const compatible = artifacts.filter(
      (artifact) => artifact.preferred && targetMatchesRuntime(artifact.target, this.runtime),
    );
    if (compatible.length !== 1)
      throw new Error("Marketplace did not return exactly one preferred compatible artifact");
    return compatible[0]!;
  }

  private async getDownloadMetadata(
    apiRoot: string,
    artifact: ArtifactMetadata,
    pluginId: string,
    version: string,
  ): Promise<DownloadMetadata> {
    const url = validateApiUrl(artifact.downloadEndpoint, apiRoot);
    const value = parseDownload(await this.requestJson(url, "Marketplace download response"));
    if (
      value.pluginId !== pluginId ||
      value.version !== version ||
      value.artifactId !== artifact.id ||
      value.sha256 !== artifact.sha256 ||
      value.size !== artifact.size
    ) {
      throw new Error("Marketplace download metadata does not match the selected artifact");
    }
    return value;
  }

  private async requestJson(url: URL, label: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Marketplace request failed with HTTP ${response.status}`);
      return await readBoundedJsonResponse(response, MAX_METADATA_BYTES, label);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadAndExtract(url: URL, artifact: ArtifactMetadata, stagingPath: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.meta-agent.plugin+zip, application/zip",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Marketplace artifact request failed with HTTP ${response.status}`);
      if (!response.body) throw new Error("Marketplace artifact response has no body");
      const stream = boundedDownload(response.body, artifact.size, this.maxArtifactBytes);
      const hash = createHash("sha256");
      const archive = await extractMarketplaceArchive(hashDownloadStream(stream, hash), stagingPath, {
        maxFiles: 2_000,
        maxCompressedBytes: Math.min(this.maxArtifactBytes, artifact.size),
        maxUncompressedBytes: 512 * 1024 * 1024,
        maxFileBytes: 128 * 1024 * 1024,
        maxPathBytes: 1_024,
      });
      if (hash.digest("hex") !== artifact.sha256) {
        throw new Error("Marketplace artifact checksum does not match metadata");
      }
      return archive;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

class CompletedMutationMap<Result> extends Map<string, Result> {
  override set(requestId: string, result: Result): this {
    if (!this.has(requestId) && this.size >= MAX_COMPLETED_MUTATIONS) {
      const oldest = this.keys().next().value;
      if (typeof oldest === "string") this.delete(oldest);
    }
    return super.set(requestId, result);
  }
}

async function* boundedDownload(body: ReadableStream<Uint8Array>, size: number, maximum: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
    throw new Error("Marketplace artifact metadata is invalid");
  }
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > size || received > maximum) throw new Error("Marketplace artifact exceeds its declared size");
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== size) throw new Error("Marketplace artifact size does not match metadata");
}

function parseArtifacts(value: unknown): ArtifactMetadata[] {
  const list = isObject(value) && Array.isArray(value.artifacts) ? value.artifacts : undefined;
  if (!list) throw new Error("Marketplace artifacts response is invalid");
  return list.map((item) => {
    if (
      !isObject(item) ||
      typeof item.id !== "string" ||
      !isObject(item.target) ||
      typeof item.target.platform !== "string" ||
      typeof item.target.arch !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.size !== "number" ||
      typeof item.containsNativeCode !== "boolean" ||
      typeof item.preferred !== "boolean" ||
      typeof item.downloadEndpoint !== "string"
    ) {
      throw new Error("Marketplace artifact metadata is invalid");
    }
    return item as unknown as ArtifactMetadata;
  });
}
function parseDownload(value: unknown): DownloadMetadata {
  if (
    !isObject(value) ||
    typeof value.pluginId !== "string" ||
    typeof value.version !== "string" ||
    typeof value.artifactId !== "string" ||
    typeof value.url !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.size !== "number"
  )
    throw new Error("Marketplace download metadata is invalid");
  return value as unknown as DownloadMetadata;
}

/** Feeds download chunks into a running SHA-256 while streaming them to extraction. */
async function* hashDownloadStream(source: AsyncIterable<Uint8Array>, hash: Hash): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
}
function validateApiUrl(value: string, apiRoot: string): URL {
  const url = new URL(value, apiRoot);
  const root = new URL(apiRoot);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (root.protocol !== "https:" && root.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== root.origin ||
    !url.pathname.startsWith(root.pathname)
  ) {
    throw new Error("Marketplace API URL escapes the trusted API root");
  }
  return url;
}
function validateArtifactUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Marketplace artifact URL origin is not trusted");
  }
  return url;
}
async function prepareInstallRoot(root: string): Promise<boolean> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Marketplace plugin destination is already occupied");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  if (await pathExists(join(root, "index.ts"))) {
    throw new Error("Marketplace plugin destination still has an active projection");
  }
  return false;
}

/** Removes a version payload and root only when this operation created them. */
async function cleanupUncommittedInstall(
  rootPath: string,
  versionPath: string,
  versionCreated: boolean,
  rootCreated: boolean,
): Promise<void> {
  if (versionCreated) await rm(versionPath, { recursive: true, force: true });
  if (rootCreated) {
    await rmdir(join(rootPath, ".versions")).catch(() => undefined);
    await rmdir(rootPath).catch(() => undefined);
  }
}

function createStagingPath(marketplaceRoot: string, pluginId: string, id: string): string {
  if (!REQUEST_ID.test(id)) throw new Error("Marketplace staging ID is invalid");
  return join(marketplaceRoot, ".meta-agent-marketplace-staging", `${pluginId}-${id}`);
}

async function prepareStagingPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { mode: 0o700 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isApplyTarget(value: unknown): value is ApplyMarketplaceMutationTarget | undefined {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0 &&
      value.projectId.length <= 200 &&
      typeof value.threadId === "string" &&
      value.threadId.length > 0 &&
      value.threadId.length <= 200 &&
      (value.abortRunning === undefined || typeof value.abortRunning === "boolean"))
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
