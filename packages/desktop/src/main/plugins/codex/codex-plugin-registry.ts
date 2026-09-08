import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { CodexMarketplaceAuthenticationPolicy, CodexMarketplaceInstallationPolicy } from "./codex-marketplace.ts";
import type { CodexPluginSourceRecord } from "./codex-plugin-sources.ts";

export const MISSING_CODEX_REGISTRY_REVISION = "missing:codex-plugins-v1";

/**
 * Codex plugin registry record. By contract it carries no
 * `hostProfileVersion`, `artifactHash`, or Desktop capability declarations:
 * those are Desktop-internal resolution concerns derived from the Codex
 * identity (name/version) and the source state (root path), never stored.
 */
export interface CodexPluginRegistryRecord {
  /** Codex plugin name; unique within the registry. */
  id: string;
  displayName: string;
  /** Installed version when installed, otherwise the currently discovered source version. */
  version: string;
  /** Current version declared by the discovered source manifest. */
  sourceVersion: string;
  /** Absolute plugin root path (realpath-resolved during discovery). */
  rootPath: string;
  /** Marketplace file the entry was declared in. */
  marketplacePath: string;
  /** Declared local source path, relative to the marketplace root. */
  sourcePath: string;
  marketplaceCategory?: string;
  installationPolicy?: CodexMarketplaceInstallationPolicy;
  authenticationPolicy?: CodexMarketplaceAuthenticationPolicy;
  products?: string[];
  enabled: boolean;
  discoveredAt: number;
  /** Desktop-managed copy root; present when the plugin was installed. */
  installedRootPath?: string;
  /** SHA-256 of the installed source content (the `.versions` payload name). */
  installedHash?: string;
}

interface RegistryFileData {
  version?: number;
  plugins?: CodexPluginRegistryRecord[];
}

export interface CodexPluginRegistrySnapshot {
  revision: string;
  plugins: CodexPluginRegistryRecord[];
}

export type CodexPluginRegistryCommit =
  | { status: "saved"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "conflict"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "not-installed"; snapshot: CodexPluginRegistrySnapshot };

export type CodexPluginEnabledCommit =
  | { status: "saved"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "conflict"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "not-installed"; snapshot: CodexPluginRegistrySnapshot };

interface CodexPluginRegistryOptions {
  createId?(): string;
}

/**
 * Persisted registry of discovered Codex plugins. Discovery happens on
 * startup and on demand; the registry keeps user state (e.g. enabled) across
 * scans and serves the extension source policy without re-scanning.
 */
export class CodexPluginRegistry {
  readonly path: string;
  private readonly createId: () => string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, options: CodexPluginRegistryOptions = {}) {
    this.path = join(userDataDir, "plugins", "codex-plugins.json");
    this.createId = options.createId ?? randomUUID;
  }

  async getSnapshot(): Promise<CodexPluginRegistrySnapshot> {
    return snapshot(await this.readCurrent());
  }

  /** Adds, updates, and removes registry records to match a discovery pass. */
  reconcile(discovered: CodexPluginSourceRecord[]): Promise<CodexPluginRegistrySnapshot> {
    const operation = this.saveTail.then(() => this.reconcileLocked(discovered));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Marks a plugin as installed (payload landed in the managed root). */
  commitInstalled(
    expectedRevision: string,
    pluginId: string,
    installedRootPath: string,
    installedHash: string,
    version: string,
  ): Promise<CodexPluginRegistryCommit> {
    const operation = this.saveTail.then(() =>
      this.commitInstalledLocked(expectedRevision, pluginId, installedRootPath, installedHash, version),
    );
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Clears the installed state of a plugin (managed copy removed). */
  commitUninstalled(expectedRevision: string, pluginId: string): Promise<CodexPluginRegistryCommit> {
    const operation = this.saveTail.then(() => this.commitUninstalledLocked(expectedRevision, pluginId));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  commitEnabled(expectedRevision: string, pluginId: string, enabled: boolean): Promise<CodexPluginEnabledCommit> {
    const operation = this.saveTail.then(() => this.commitEnabledLocked(expectedRevision, pluginId, enabled));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reconcileLocked(discovered: CodexPluginSourceRecord[]): Promise<CodexPluginRegistrySnapshot> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      const existing = new Map(current.data.plugins?.map((plugin) => [plugin.id, plugin]) ?? []);
      const plugins: CodexPluginRegistryRecord[] = [];
      const seen = new Set<string>();
      for (const plugin of discovered) {
        if (seen.has(plugin.name)) continue; // defensive: never persist duplicate IDs
        seen.add(plugin.name);
        const previous = existing.get(plugin.name);
        const sameLocation =
          previous !== undefined &&
          previous.rootPath === plugin.rootPath &&
          previous.sourcePath === plugin.sourcePath &&
          previous.marketplacePath === plugin.marketplacePath;
        plugins.push({
          id: plugin.name,
          displayName: plugin.displayName,
          version: sameLocation && previous.installedHash ? previous.version : plugin.version,
          sourceVersion: plugin.version,
          rootPath: plugin.rootPath,
          marketplacePath: plugin.marketplacePath,
          sourcePath: plugin.sourcePath,
          ...(plugin.marketplaceCategory ? { marketplaceCategory: plugin.marketplaceCategory } : {}),
          ...(plugin.installationPolicy ? { installationPolicy: plugin.installationPolicy } : {}),
          ...(plugin.authenticationPolicy ? { authenticationPolicy: plugin.authenticationPolicy } : {}),
          ...(plugin.products ? { products: [...plugin.products] } : {}),
          enabled: sameLocation ? previous.enabled : true,
          discoveredAt: previous?.discoveredAt ?? Date.now(),
          // Source version changes mark an update as available but do not silently uninstall the managed copy.
          ...(sameLocation && previous?.installedHash && previous.installedRootPath
            ? { installedRootPath: previous.installedRootPath, installedHash: previous.installedHash }
            : {}),
        });
      }
      if (
        plugins.length === current.data.plugins?.length &&
        plugins.every((plugin, index) => recordsEqual(plugin, current.data.plugins?.[index]))
      ) {
        return snapshot(current);
      }
      await this.atomicWrite({ version: 1, plugins });
      return this.getSnapshot();
    } finally {
      await release();
    }
  }

  private async commitInstalledLocked(
    expectedRevision: string,
    pluginId: string,
    installedRootPath: string,
    installedHash: string,
    version: string,
  ): Promise<CodexPluginRegistryCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) {
        return { status: "conflict", snapshot: snapshot(current) };
      }
      const plugins = (current.data.plugins ?? []).map((plugin) =>
        plugin.id === pluginId ? { ...plugin, installedRootPath, installedHash, version } : plugin,
      );
      const index = plugins.findIndex((plugin) => plugin.id === pluginId);
      if (index < 0) return { status: "not-installed", snapshot: snapshot(current) };
      await this.atomicWrite({ version: 1, plugins });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitUninstalledLocked(
    expectedRevision: string,
    pluginId: string,
  ): Promise<CodexPluginRegistryCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) {
        return { status: "conflict", snapshot: snapshot(current) };
      }
      if (!current.data.plugins?.some((plugin) => plugin.id === pluginId && plugin.installedHash)) {
        return { status: "not-installed", snapshot: snapshot(current) };
      }
      const plugins = current.data.plugins.map((plugin) =>
        plugin.id === pluginId
          ? { ...plugin, version: plugin.sourceVersion, installedRootPath: undefined, installedHash: undefined }
          : plugin,
      );
      await this.atomicWrite({ version: 1, plugins });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async commitEnabledLocked(
    expectedRevision: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<CodexPluginEnabledCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: snapshot(current) };
      const plugins = current.data.plugins;
      if (!plugins?.some((plugin) => plugin.id === pluginId && plugin.installedHash)) {
        return { status: "not-installed", snapshot: snapshot(current) };
      }
      await this.atomicWrite({
        version: 1,
        plugins: plugins.map((plugin) => (plugin.id === pluginId ? { ...plugin, enabled } : plugin)),
      });
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentRegistry> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`codex-plugins.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { revision: MISSING_CODEX_REGISTRY_REVISION, data: {} };
      throw error;
    }
    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("codex-plugins.json JSON syntax invalid");
    }
    assertRegistryFile(value);
    return { revision: createHash("sha256").update(bytes).digest("hex"), data: value };
  }

  private async atomicWrite(data: RegistryFileData): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.codex-plugins.${process.pid}.${this.createId()}.tmp`);
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

interface CurrentRegistry {
  revision: string;
  data: RegistryFileData;
}

function snapshot(current: CurrentRegistry): CodexPluginRegistrySnapshot {
  return {
    revision: current.revision,
    plugins: (current.data.plugins ?? []).map((plugin) => ({ ...plugin })),
  };
}

function recordsEqual(
  left: CodexPluginRegistryRecord | undefined,
  right: CodexPluginRegistryRecord | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.displayName === right.displayName &&
    left.version === right.version &&
    left.sourceVersion === right.sourceVersion &&
    left.rootPath === right.rootPath &&
    left.marketplacePath === right.marketplacePath &&
    left.sourcePath === right.sourcePath &&
    left.marketplaceCategory === right.marketplaceCategory &&
    left.installationPolicy === right.installationPolicy &&
    left.authenticationPolicy === right.authenticationPolicy &&
    JSON.stringify(left.products ?? []) === JSON.stringify(right.products ?? []) &&
    left.enabled === right.enabled &&
    left.installedRootPath === right.installedRootPath &&
    left.installedHash === right.installedHash
  );
}

function assertRegistryFile(value: unknown): asserts value is RegistryFileData {
  if (!isPlainObject(value)) throw new Error("codex-plugins.json must be an object");
  if (value.version !== undefined && value.version !== 1) throw new Error("codex-plugins.json version is unsupported");
  if (value.plugins === undefined) return;
  if (!Array.isArray(value.plugins)) throw new Error("codex-plugins.json plugins must be an array");
  const ids = new Set<string>();
  for (const plugin of value.plugins) {
    if (
      !isPlainObject(plugin) ||
      typeof plugin.id !== "string" ||
      plugin.id.length === 0 ||
      typeof plugin.displayName !== "string" ||
      plugin.displayName.length === 0 ||
      typeof plugin.version !== "string" ||
      plugin.version.length === 0 ||
      (plugin.sourceVersion !== undefined &&
        (typeof plugin.sourceVersion !== "string" || plugin.sourceVersion.length === 0)) ||
      typeof plugin.rootPath !== "string" ||
      typeof plugin.marketplacePath !== "string" ||
      typeof plugin.sourcePath !== "string" ||
      (plugin.marketplaceCategory !== undefined && typeof plugin.marketplaceCategory !== "string") ||
      (plugin.installationPolicy !== undefined &&
        plugin.installationPolicy !== "NOT_AVAILABLE" &&
        plugin.installationPolicy !== "AVAILABLE" &&
        plugin.installationPolicy !== "INSTALLED_BY_DEFAULT") ||
      (plugin.authenticationPolicy !== undefined &&
        plugin.authenticationPolicy !== "ON_INSTALL" &&
        plugin.authenticationPolicy !== "ON_USE") ||
      (plugin.products !== undefined &&
        (!Array.isArray(plugin.products) || !plugin.products.every((product) => typeof product === "string"))) ||
      typeof plugin.enabled !== "boolean" ||
      !Number.isSafeInteger(plugin.discoveredAt) ||
      (plugin.discoveredAt as number) < 0 ||
      (plugin.installedRootPath !== undefined &&
        (typeof plugin.installedRootPath !== "string" || plugin.installedRootPath.length === 0)) ||
      (plugin.installedHash !== undefined &&
        (typeof plugin.installedHash !== "string" || !/^[a-f0-9]{64}$/.test(plugin.installedHash)))
    ) {
      throw new Error("codex-plugins.json plugin entry is invalid");
    }
    plugin.sourceVersion ??= plugin.version;
    if (ids.has(plugin.id)) throw new Error(`codex-plugins.json duplicate plugin ID: ${plugin.id}`);
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
