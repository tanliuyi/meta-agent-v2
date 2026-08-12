import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
  clonePluginConfigurationSchema,
  type PluginConfigurationSchema,
  parsePluginConfigurationSchema,
} from "../../shared/plugin-configuration-contracts.ts";
import type {
  InstalledMarketplacePluginSummary,
  InstalledMarketplacePluginsSnapshot,
  MarketplacePluginScope,
} from "../../shared/plugin-marketplace-contracts.ts";

export const MISSING_MARKETPLACE_REGISTRY_REVISION = "missing:marketplace-installed-v1";

export interface InstalledMarketplacePluginRecord extends Omit<InstalledMarketplacePluginSummary, "configurable"> {
  artifactHash: string;
  entryPath: string;
  rootPath: string;
  configurationSchema?: PluginConfigurationSchema;
}

interface RegistryFileData {
  version?: number;
  plugins?: InstalledMarketplacePluginRecord[];
  [key: string]: unknown;
}

interface CurrentRegistry {
  revision: string;
  data: RegistryFileData;
}

interface MarketplacePluginRegistryOptions {
  createId?(): string;
}

export class MarketplacePluginRegistry {
  readonly path: string;
  private readonly createId: () => string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, options: MarketplacePluginRegistryOptions = {}) {
    this.path = join(userDataDir, "plugins", "installed.json");
    this.createId = options.createId ?? randomUUID;
  }

  async getSnapshot(): Promise<InstalledMarketplacePluginsSnapshot> {
    return snapshot(await this.readCurrent());
  }

  async getInternalSnapshot(): Promise<{ revision: string; plugins: InstalledMarketplacePluginRecord[] }> {
    const current = await this.readCurrent();
    return { revision: current.revision, plugins: (current.data.plugins ?? []).map(cloneRecord) };
  }

  commitInstall(
    expectedRevision: string,
    record: InstalledMarketplacePluginRecord,
  ): Promise<{ status: "saved" | "conflict" | "already-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    const operation = this.saveTail.then(() => this.commitInstallLocked(expectedRevision, record));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  commitUpdate(
    expectedRevision: string,
    expectedArtifactHash: string,
    record: InstalledMarketplacePluginRecord,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    const operation = this.saveTail.then(() => this.commitUpdateLocked(expectedRevision, expectedArtifactHash, record));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  commitUninstall(
    expectedRevision: string,
    pluginId: string,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    const operation = this.saveTail.then(() => this.commitUninstallLocked(expectedRevision, pluginId));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  commitEnabled(
    expectedRevision: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<{
    status: "saved" | "conflict" | "not-installed" | "broken";
    snapshot: InstalledMarketplacePluginsSnapshot;
  }> {
    const operation = this.saveTail.then(() => this.commitEnabledLocked(expectedRevision, pluginId, enabled));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  commitScope(
    expectedRevision: string,
    pluginId: string,
    scope: MarketplacePluginScope,
    projectIds: string[] | undefined,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    const operation = this.saveTail.then(async () => {
      if (scope !== "global" && scope !== "project") throw new Error("Marketplace plugin scope is invalid");
      if (scope === "project") {
        if (!projectIds || projectIds.length === 0) {
          throw new Error("Marketplace project plugin requires at least one project");
        }
        if (
          projectIds.some(
            (projectId) => typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200,
          )
        ) {
          throw new Error("Marketplace project plugin has an invalid project ID");
        }
      }
      return this.commitScopeLocked(expectedRevision, pluginId, scope, projectIds);
    });
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  reconcilePlugin(
    pluginId: string,
    expectedArtifactHash: string,
    desired: InstalledMarketplacePluginRecord | undefined,
  ): Promise<InstalledMarketplacePluginsSnapshot> {
    const operation = this.saveTail.then(() => this.reconcilePluginLocked(pluginId, expectedArtifactHash, desired));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  markInstalled(pluginId: string, artifactHash: string): Promise<InstalledMarketplacePluginsSnapshot> {
    const operation = this.saveTail.then(async () => {
      const current = await this.getInternalSnapshot();
      const record = current.plugins.find((plugin) => plugin.id === pluginId);
      if (!record || record.artifactHash !== artifactHash) return this.getSnapshot();
      return this.reconcilePluginLocked(pluginId, artifactHash, { ...record, state: "installed", enabled: true });
    });
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  markBroken(pluginId: string, artifactHash: string): Promise<InstalledMarketplacePluginsSnapshot> {
    const operation = this.saveTail.then(async () => {
      const current = await this.getInternalSnapshot();
      const record = current.plugins.find((plugin) => plugin.id === pluginId);
      if (!record || record.artifactHash !== artifactHash) return this.getSnapshot();
      return this.reconcilePluginLocked(pluginId, artifactHash, { ...record, state: "broken", enabled: false });
    });
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async commitInstallLocked(
    expectedRevision: string,
    record: InstalledMarketplacePluginRecord,
  ): Promise<{ status: "saved" | "conflict" | "already-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      const existing = current.data.plugins?.find((plugin) => plugin.id === record.id);
      if (existing) return { status: "already-installed", snapshot: snapshot(current) };
      await this.atomicWrite({
        ...current.data,
        version: 1,
        plugins: [...(current.data.plugins ?? []).map(cloneRecord), cloneRecord(record)],
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitUpdateLocked(
    expectedRevision: string,
    expectedArtifactHash: string,
    record: InstalledMarketplacePluginRecord,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lockRegistry();
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      const existing = current.data.plugins?.find((plugin) => plugin.id === record.id);
      if (!existing) return { status: "not-installed", snapshot: snapshot(current) };
      if (existing.artifactHash !== expectedArtifactHash) return { status: "conflict", snapshot: snapshot(current) };
      await this.atomicWrite({
        ...current.data,
        version: 1,
        plugins: (current.data.plugins ?? []).map((plugin) =>
          plugin.id === record.id ? cloneRecord(record) : cloneRecord(plugin),
        ),
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitUninstallLocked(
    expectedRevision: string,
    pluginId: string,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lockRegistry();
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      if (!current.data.plugins?.some((plugin) => plugin.id === pluginId)) {
        return { status: "not-installed", snapshot: snapshot(current) };
      }
      await this.atomicWrite({
        ...current.data,
        version: 1,
        plugins: current.data.plugins.filter((plugin) => plugin.id !== pluginId).map(cloneRecord),
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitEnabledLocked(
    expectedRevision: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<{
    status: "saved" | "conflict" | "not-installed" | "broken";
    snapshot: InstalledMarketplacePluginsSnapshot;
  }> {
    if (typeof enabled !== "boolean") throw new Error("Marketplace plugin enabled state is invalid");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lockRegistry();
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      const existing = current.data.plugins?.find((plugin) => plugin.id === pluginId);
      if (!existing) return { status: "not-installed", snapshot: snapshot(current) };
      if (existing.state === "broken") return { status: "broken", snapshot: snapshot(current) };
      await this.atomicWrite({
        ...current.data,
        version: 1,
        plugins: (current.data.plugins ?? []).map((plugin) =>
          plugin.id === pluginId ? cloneRecord({ ...existing, enabled }) : cloneRecord(plugin),
        ),
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitScopeLocked(
    expectedRevision: string,
    pluginId: string,
    scope: MarketplacePluginScope,
    projectIds: string[] | undefined,
  ): Promise<{ status: "saved" | "conflict" | "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lockRegistry();
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      const existing = current.data.plugins?.find((plugin) => plugin.id === pluginId);
      if (!existing) return { status: "not-installed", snapshot: snapshot(current) };
      await this.atomicWrite({
        ...current.data,
        version: 1,
        plugins: (current.data.plugins ?? []).map((plugin) =>
          plugin.id === pluginId
            ? cloneRecord({
                ...existing,
                scope,
                projectIds: scope === "project" ? dedupeProjectIds(projectIds!) : undefined,
              })
            : cloneRecord(plugin),
        ),
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async reconcilePluginLocked(
    pluginId: string,
    expectedArtifactHash: string,
    desired: InstalledMarketplacePluginRecord | undefined,
  ): Promise<InstalledMarketplacePluginsSnapshot> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lockRegistry();
    try {
      const current = await this.readCurrent();
      const existing = current.data.plugins?.find((plugin) => plugin.id === pluginId);
      if (existing && existing.artifactHash !== expectedArtifactHash) {
        throw new Error(`Marketplace registry contains a different artifact for ${pluginId}`);
      }
      const plugins = (current.data.plugins ?? []).filter((plugin) => plugin.id !== pluginId).map(cloneRecord);
      if (desired) plugins.push(cloneRecord(desired));
      await this.atomicWrite({ ...current.data, version: 1, plugins });
      return this.getSnapshot();
    } finally {
      await release();
    }
  }

  private lockRegistry(): Promise<() => Promise<void>> {
    return lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
  }

  private async readCurrent(): Promise<CurrentRegistry> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`installed.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { revision: MISSING_MARKETPLACE_REGISTRY_REVISION, data: {} };
      throw error;
    }
    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("installed.json JSON syntax invalid");
    }
    assertRegistryFile(value);
    const plugins = (value.plugins ?? []).map(normalizeRecord);
    return { revision: createHash("sha256").update(bytes).digest("hex"), data: { ...value, plugins } };
  }

  private async atomicWrite(data: RegistryFileData): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.installed.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.path);
      await chmod(this.path, 0o600);
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function snapshot(current: CurrentRegistry): InstalledMarketplacePluginsSnapshot {
  return {
    revision: current.revision,
    plugins: (current.data.plugins ?? []).map(
      ({
        artifactHash: _artifactHash,
        entryPath: _entryPath,
        rootPath: _rootPath,
        configurationSchema,
        ...plugin
      }) => ({
        ...plugin,
        configurable: configurationSchema !== undefined,
        capabilities: [...plugin.capabilities],
      }),
    ),
  };
}

function cloneRecord(record: InstalledMarketplacePluginRecord): InstalledMarketplacePluginRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    ...(record.configurationSchema
      ? { configurationSchema: clonePluginConfigurationSchema(record.configurationSchema) }
      : {}),
  };
}

type NormalizedInstalledMarketplacePluginRecord = InstalledMarketplacePluginRecord & { projectId?: undefined };

/** 旧版本 registry 记录没有 scope 字段；读取时归一为 global，并清理 global 记录的残留项目列表。 */
function normalizeRecord(
  record: InstalledMarketplacePluginRecord & { projectId?: string },
): NormalizedInstalledMarketplacePluginRecord {
  const { projectId: legacyProjectId, ...recordWithoutLegacyProjectId } = record;
  const scope = record.scope === "project" ? "project" : "global";
  if (scope !== "project") {
    return { ...recordWithoutLegacyProjectId, scope, projectId: undefined, projectIds: undefined };
  }
  const projectIds = dedupeProjectIds([
    ...(record.projectIds ?? []),
    ...(typeof legacyProjectId === "string" && legacyProjectId.length > 0 ? [legacyProjectId] : []),
  ]);
  return { ...recordWithoutLegacyProjectId, scope, projectId: undefined, projectIds };
}

function dedupeProjectIds(projectIds: string[]): string[] {
  return [...new Set(projectIds)];
}

function assertRegistryFile(value: unknown): asserts value is RegistryFileData {
  if (!isPlainObject(value)) throw new Error("installed.json must be an object");
  if (value.version !== undefined && value.version !== 1) throw new Error("installed.json version is unsupported");
  if (value.plugins === undefined) return;
  if (!Array.isArray(value.plugins)) throw new Error("installed.json plugins must be an array");
  const ids = new Set<string>();
  for (const plugin of value.plugins) {
    if (
      !isPlainObject(plugin) ||
      typeof plugin.id !== "string" ||
      typeof plugin.displayName !== "string" ||
      typeof plugin.marketplaceId !== "string" ||
      typeof plugin.version !== "string" ||
      typeof plugin.artifactId !== "string" ||
      typeof plugin.artifactHash !== "string" ||
      typeof plugin.entryPath !== "string" ||
      typeof plugin.rootPath !== "string" ||
      typeof plugin.enabled !== "boolean" ||
      !Array.isArray(plugin.capabilities) ||
      !plugin.capabilities.every((capability) => typeof capability === "string") ||
      typeof plugin.containsNativeCode !== "boolean" ||
      (plugin.state !== "installed" && plugin.state !== "broken") ||
      typeof plugin.installedAt !== "number" ||
      (plugin.scope !== undefined && plugin.scope !== "global" && plugin.scope !== "project") ||
      (plugin.scope === "project" && !Array.isArray(plugin.projectIds) && typeof plugin.projectId !== "string") ||
      (plugin.scope === "project" &&
        Array.isArray(plugin.projectIds) &&
        (plugin.projectIds.length === 0 ||
          !plugin.projectIds.every(
            (projectId) => typeof projectId === "string" && projectId.length > 0 && projectId.length <= 200,
          ))) ||
      (plugin.scope === "project" &&
        typeof plugin.projectId === "string" &&
        (plugin.projectId.length === 0 || plugin.projectId.length > 200)) ||
      (plugin.scope === "project" &&
        plugin.projectIds !== undefined &&
        (!Array.isArray(plugin.projectIds) ||
          !plugin.projectIds.every((projectId: unknown) => typeof projectId === "string"))) ||
      (plugin.scope !== "project" && plugin.projectIds !== undefined && !Array.isArray(plugin.projectIds))
    ) {
      throw new Error("installed.json plugin entry is invalid");
    }
    if (plugin.configurationSchema !== undefined) {
      parsePluginConfigurationSchema(plugin.configurationSchema);
      if (!plugin.capabilities.includes("configuration.read")) {
        throw new Error("installed.json configurable plugin lacks configuration.read capability");
      }
    }
    if (ids.has(plugin.id)) throw new Error(`installed.json duplicate plugin ID: ${plugin.id}`);
    ids.add(plugin.id);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
