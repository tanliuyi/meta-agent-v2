import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { valid } from "semver";
import { withCodexPluginLock } from "./codex-plugin-lock.ts";
import { type CodexPluginManifest, loadCodexPluginManifest } from "./codex-plugin-manifest.ts";
import type {
  CodexPluginRegistry,
  CodexPluginRegistryRecord,
  CodexPluginRegistrySnapshot,
} from "./codex-plugin-registry.ts";

/**
 * Installs, updates and uninstalls Codex plugins as Desktop-managed copies.
 *
 * The source tree is never written: the plugin manifest, the Marketplace JSON
 * and the plugin source stay untouched. Installation copies the source into
 * the Desktop managed root under a content-addressed `.versions` payload and
 * commits the installed state through the Codex registry. Updates follow the
 * Codex cachebuster convention (`<base-version>+codex.<token>`) so that local
 * development iterations that keep the manifest version derive a new worker
 * generation without touching the source manifest.
 *
 * Crash recovery uses the registry as the
 * single commit point, payloads land by atomic rename, and a startup
 * reconciler removes payloads that never committed.
 */

export const CODEX_MUTATION_REQUEST_ID = /^[a-zA-Z0-9._-]{1,128}$/;
const CODEX_PLUGIN_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_COMPLETED_MUTATIONS = 256;
const VERSION_DIRECTORY = ".versions";

export type CodexPluginInstallResult =
  | { status: "installed"; snapshot: CodexPluginRegistrySnapshot; recoveryPending?: boolean }
  | { status: "already-installed"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "conflict"; current: CodexPluginRegistrySnapshot };

export type CodexPluginUpdateResult =
  | { status: "updated"; snapshot: CodexPluginRegistrySnapshot; reloadRequired: true; recoveryPending?: boolean }
  | { status: "same-version"; snapshot: CodexPluginRegistrySnapshot; reloadRequired: false }
  | { status: "not-installed"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "conflict"; current: CodexPluginRegistrySnapshot };

export type CodexPluginUninstallResult =
  | { status: "uninstalled"; snapshot: CodexPluginRegistrySnapshot; reloadRequired: true; recoveryPending?: boolean }
  | { status: "not-installed"; snapshot: CodexPluginRegistrySnapshot }
  | { status: "conflict"; current: CodexPluginRegistrySnapshot };

export interface CodexPluginMutationInput {
  /** Registry plugin id (the Codex plugin name). */
  pluginId: string;
  /** Idempotency key; completed mutations are replayed for the same request id. */
  requestId: string;
  /** Registry revision the mutation expects; mismatches return `conflict`. */
  expectedRevision: string;
  /** Explicit full-trust confirmation, required for install and update. */
  confirmFullTrust?: boolean;
  /** Explicit removal confirmation, required for uninstall. */
  confirmRemoval?: boolean;
}

interface CodexPluginInstallerOptions {
  createId?(): string;
  now?(): number;
  /** Test seam: invoked after the payload landed and before the registry commit. */
  beforeRegistryCommit?(rootPath: string, versionPath: string): Promise<void>;
}

/** Content hash of a plugin root: sorted relative paths plus file bytes. */
export async function hashCodexPluginRoot(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  await collectCodexPluginFiles(rootPath, rootPath, "", hash);
  return hash.digest("hex");
}

async function collectCodexPluginFiles(
  root: string,
  directory: string,
  relativePrefix: string,
  hash: ReturnType<typeof createHash>,
) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === VERSION_DIRECTORY || entry.name.startsWith(".meta-agent")) continue;
    const full = join(directory, entry.name);
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectCodexPluginFiles(root, full, relative, hash);
      continue;
    }
    const content = await readFile(full).catch(() => {
      throw new Error(`Codex plugin source is unreadable at ${full}`);
    });
    hash.update(relative);
    hash.update(content);
  }
}

export class CodexPluginInstaller {
  private readonly registry: CodexPluginRegistry;
  private readonly lockDirectory: string;
  private readonly codexRoot: string;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly beforeRegistryCommit?: (rootPath: string, versionPath: string) => Promise<void>;
  private readonly completedInstalls = new CompletedMutationMap<CodexPluginInstallResult>();
  private readonly completedUpdates = new CompletedMutationMap<CodexPluginUpdateResult>();
  private readonly completedUninstalls = new CompletedMutationMap<CodexPluginUninstallResult>();

  constructor(
    registry: CodexPluginRegistry,
    lockDirectory: string,
    codexRoot: string,
    options: CodexPluginInstallerOptions = {},
  ) {
    this.registry = registry;
    this.lockDirectory = lockDirectory;
    this.codexRoot = codexRoot;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.beforeRegistryCommit = options.beforeRegistryCommit;
  }

  install(input: CodexPluginMutationInput): Promise<CodexPluginInstallResult> {
    return withCodexPluginLock(this.lockDirectory, input.pluginId, () => this.installSerialized(input));
  }

  update(input: CodexPluginMutationInput): Promise<CodexPluginUpdateResult> {
    return withCodexPluginLock(this.lockDirectory, input.pluginId, () => this.updateSerialized(input));
  }

  uninstall(input: CodexPluginMutationInput): Promise<CodexPluginUninstallResult> {
    return withCodexPluginLock(this.lockDirectory, input.pluginId, () => this.uninstallSerialized(input));
  }

  clearCompletedMutation(requestId: string): void {
    this.completedInstalls.delete(requestId);
    this.completedUpdates.delete(requestId);
    this.completedUninstalls.delete(requestId);
  }

  private async installSerialized(input: CodexPluginMutationInput): Promise<CodexPluginInstallResult> {
    const cached = this.completedInstalls.get(input.requestId);
    if (cached) return cached;
    validateMutationInput(input, "install");
    const initial = await this.registry.getSnapshot();
    if (initial.revision !== input.expectedRevision) return { status: "conflict", current: initial };
    const record = initial.plugins.find((plugin) => plugin.id === input.pluginId);
    if (!record) throw new Error(`Codex plugin is not discovered: ${input.pluginId}`);
    if (record.installedHash && record.installedRootPath) {
      // payload 中途缺失时不能短路：按正常流程重新复制修复
      if (await pathExists(join(record.installedRootPath, VERSION_DIRECTORY, record.installedHash))) {
        const result: CodexPluginInstallResult = { status: "already-installed", snapshot: initial };
        this.completedInstalls.set(input.requestId, result);
        return result;
      }
    }
    const verified = await this.verifySource(record);
    const hashValue = await hashCodexPluginRoot(record.rootPath);
    const rootPath = join(this.codexRoot, input.pluginId);
    const versionPath = join(rootPath, VERSION_DIRECTORY, hashValue);
    const stagingPath = createStagingPath(this.codexRoot, input.pluginId, this.createId());
    await prepareStagingPath(stagingPath);
    let rootCreated = false;
    let versionCreated = false;
    let registryCommitted = false;
    try {
      await copyPluginSource(record.rootPath, stagingPath);
      // 哈希后再复制的窗口内源可能被改动：payload 目录名必须与内容一致
      if ((await hashCodexPluginRoot(stagingPath)) !== hashValue) {
        throw new Error("Codex plugin source changed while it was being copied");
      }
      await syncDirectory(dirname(stagingPath));
      rootCreated = await prepareInstallRoot(rootPath);
      await mkdir(dirname(versionPath), { recursive: true, mode: 0o700 });
      versionCreated = await landPayload(stagingPath, versionPath, hashValue);
      await syncDirectory(dirname(versionPath));
      await syncDirectory(rootPath);
      if (rootCreated) await syncDirectory(dirname(rootPath));
      await this.beforeRegistryCommit?.(rootPath, versionPath);
      const saved = await this.registry.commitInstalled(
        input.expectedRevision,
        input.pluginId,
        rootPath,
        hashValue,
        verified.version,
      );
      if (saved.status !== "saved") {
        await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, rootCreated);
        return { status: "conflict", current: saved.snapshot };
      }
      registryCommitted = true;
      const result: CodexPluginInstallResult = { status: "installed", snapshot: saved.snapshot };
      this.completedInstalls.set(input.requestId, result);
      return result;
    } catch (error) {
      if (!registryCommitted) {
        try {
          registryCommitted =
            (await this.registry.getSnapshot()).plugins.find((plugin) => plugin.id === input.pluginId)
              ?.installedHash === hashValue;
        } catch {
          // 注册表文件本身损坏时无法复核；按未提交处理，正常清理并抛原错误。
        }
      }
      if (registryCommitted) {
        const result: CodexPluginInstallResult = {
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

  private async updateSerialized(input: CodexPluginMutationInput): Promise<CodexPluginUpdateResult> {
    const cached = this.completedUpdates.get(input.requestId);
    if (cached) return cached;
    validateMutationInput(input, "update");
    const initial = await this.registry.getSnapshot();
    if (initial.revision !== input.expectedRevision) {
      return { status: "conflict", current: await this.registry.getSnapshot() };
    }
    const before = initial.plugins.find((plugin) => plugin.id === input.pluginId);
    if (!before) {
      const result: CodexPluginUpdateResult = { status: "not-installed", snapshot: await this.registry.getSnapshot() };
      this.completedUpdates.set(input.requestId, result);
      return result;
    }
    if (!before.installedHash || !before.installedRootPath) {
      const result: CodexPluginUpdateResult = { status: "not-installed", snapshot: await this.registry.getSnapshot() };
      this.completedUpdates.set(input.requestId, result);
      return result;
    }
    const verified = await this.verifySource(before);
    const hashValue = await hashCodexPluginRoot(before.rootPath);
    if (
      hashValue === before.installedHash &&
      (await pathExists(join(before.installedRootPath!, VERSION_DIRECTORY, before.installedHash)))
    ) {
      const result: CodexPluginUpdateResult = {
        status: "same-version",
        snapshot: await this.registry.getSnapshot(),
        reloadRequired: false,
      };
      this.completedUpdates.set(input.requestId, result);
      return result;
    }
    const nextVersion = deriveUpdateVersion(before, verified.version, this.now());
    // 删除路径只接受受管根内的副本：篡改的 codex-plugins.json 不得让卸载/更新 rm -rf 任意目录
    const rootPath = this.requireManagedRoot(input.pluginId, before.installedRootPath);
    const versionPath = join(rootPath, VERSION_DIRECTORY, hashValue);
    const stagingPath = createStagingPath(this.codexRoot, input.pluginId, this.createId());
    await prepareStagingPath(stagingPath);
    let versionCreated = false;
    let registryCommitted = false;
    try {
      await copyPluginSource(before.rootPath, stagingPath);
      // 哈希后再复制的窗口内源可能被改动：payload 目录名必须与内容一致
      if ((await hashCodexPluginRoot(stagingPath)) !== hashValue) {
        throw new Error("Codex plugin source changed while it was being copied");
      }
      await syncDirectory(dirname(stagingPath));
      await mkdir(dirname(versionPath), { recursive: true, mode: 0o700 });
      versionCreated = await landPayload(stagingPath, versionPath, hashValue);
      await syncDirectory(dirname(versionPath));
      await syncDirectory(rootPath);
      await this.beforeRegistryCommit?.(rootPath, versionPath);
      const saved = await this.registry.commitInstalled(
        input.expectedRevision,
        input.pluginId,
        rootPath,
        hashValue,
        nextVersion,
      );
      if (saved.status !== "saved") {
        await cleanupUncommittedInstall(rootPath, versionPath, versionCreated, false);
        return { status: "conflict", current: saved.status === "conflict" ? saved.snapshot : initial };
      }
      registryCommitted = true;
      // Old workers and replacement rollback still use the previous payload.
      // Only startup reconciliation, before any workers exist, may collect it.
      const result: CodexPluginUpdateResult = {
        status: "updated",
        snapshot: saved.snapshot,
        reloadRequired: true,
      };
      this.completedUpdates.set(input.requestId, result);
      return result;
    } catch (error) {
      if (!registryCommitted) {
        try {
          registryCommitted =
            (await this.registry.getSnapshot()).plugins.find((plugin) => plugin.id === input.pluginId)
              ?.installedHash === hashValue;
        } catch {
          // 注册表文件本身损坏时无法复核；按未提交处理，正常清理并抛原错误。
        }
      }
      if (registryCommitted) {
        const result: CodexPluginUpdateResult = {
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

  private async uninstallSerialized(input: CodexPluginMutationInput): Promise<CodexPluginUninstallResult> {
    const cached = this.completedUninstalls.get(input.requestId);
    if (cached) return cached;
    validateMutationInput(input, "uninstall");
    const initial = await this.registry.getSnapshot();
    if (initial.revision !== input.expectedRevision) {
      return { status: "conflict", current: await this.registry.getSnapshot() };
    }
    const record = initial.plugins.find((plugin) => plugin.id === input.pluginId);
    if (!record?.installedHash || !record.installedRootPath) {
      const result: CodexPluginUninstallResult = {
        status: "not-installed",
        snapshot: await this.registry.getSnapshot(),
      };
      this.completedUninstalls.set(input.requestId, result);
      return result;
    }
    this.requireManagedRoot(input.pluginId, record.installedRootPath);
    const saved = await this.registry.commitUninstalled(input.expectedRevision, input.pluginId);
    if (saved.status !== "saved") {
      if (saved.status === "conflict") return { status: "conflict", current: saved.snapshot };
      const result: CodexPluginUninstallResult = {
        status: "not-installed",
        snapshot: saved.snapshot,
      };
      this.completedUninstalls.set(input.requestId, result);
      return result;
    }
    // Uninstall immediately excludes new resolutions. Existing generations keep
    // their files until startup reconciliation, including rollback snapshots.
    const result: CodexPluginUninstallResult = {
      status: "uninstalled",
      snapshot: saved.snapshot,
      reloadRequired: true,
    };
    this.completedUninstalls.set(input.requestId, result);
    return result;
  }

  private requireManagedRoot(pluginId: string, installedRootPath: string | undefined): string {
    const expected = resolve(join(this.codexRoot, pluginId));
    if (!installedRootPath || resolve(installedRootPath) !== expected) {
      throw new Error(`Codex plugin managed copy is outside the Desktop root: ${pluginId}`);
    }
    return expected;
  }

  private async verifySource(record: CodexPluginRegistryRecord): Promise<CodexPluginManifest> {
    const loaded = await loadCodexPluginManifest(record.rootPath);
    if (loaded.manifest === undefined) {
      throw new Error(`Codex plugin manifest is invalid: ${record.id}`);
    }
    if (loaded.manifest.name !== record.id) {
      throw new Error(`Codex plugin manifest name does not match the registry entry: ${record.id}`);
    }
    if (!valid(loaded.manifest.version)) {
      throw new Error(`Codex plugin manifest version is not strict semver: ${record.id}`);
    }
    return loaded.manifest;
  }
}

/** Update version: source bumps replace the record, manifest-stable content changes get a Codex cachebuster suffix. */
export function deriveUpdateVersion(record: CodexPluginRegistryRecord, sourceVersion: string, now: number): string {
  const oldBase = record.version.split("+")[0];
  const newBase = sourceVersion.split("+")[0];
  if (newBase !== oldBase) return sourceVersion;
  return `${newBase}+codex.${defaultCachebusterToken(now)}`;
}

/** UTC timestamp token matching the Codex `update_plugin_cachebuster` default (`%Y%m%d%H%M%S`). */
export function defaultCachebusterToken(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

async function copyPluginSource(sourceRoot: string, targetRoot: string): Promise<void> {
  // The private staging directory is already reserved. Copy its children without
  // weakening errorOnExist, which must still reject unexpected destination files.
  for (const entry of await readdir(sourceRoot)) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: true,
      filter: (source) => {
        const name = source.split(/[\\/]/).pop() ?? "";
        if (name.startsWith(".meta-agent") || name === ".versions") return false;
        return true;
      },
    });
  }
}

async function landPayload(stagingPath: string, versionPath: string, expectedHash: string): Promise<boolean> {
  if (await pathExists(versionPath)) {
    const info = await lstat(versionPath);
    if (!info.isDirectory() || info.isSymbolicLink() || (await hashCodexPluginRoot(versionPath)) !== expectedHash) {
      throw new Error("Retained Codex payload does not match its content hash");
    }
    await rm(stagingPath, { recursive: true, force: true });
    return false;
  }
  await rename(stagingPath, versionPath);
  return true;
}

async function prepareInstallRoot(root: string): Promise<boolean> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Codex plugin destination is already occupied");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  return false;
}

async function cleanupUncommittedInstall(
  rootPath: string,
  versionPath: string,
  versionCreated: boolean,
  rootCreated: boolean,
): Promise<void> {
  if (versionCreated) await rm(versionPath, { recursive: true, force: true });
  if (rootCreated) {
    await rmdir(join(rootPath, VERSION_DIRECTORY)).catch(() => undefined);
    await rmdir(rootPath).catch(() => undefined);
  }
}

function createStagingPath(codexRoot: string, pluginId: string, id: string): string {
  if (!CODEX_MUTATION_REQUEST_ID.test(id)) throw new Error("Codex staging ID is invalid");
  return join(codexRoot, ".meta-agent-codex-staging", `${pluginId}-${id}`);
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

function validateMutationInput(input: CodexPluginMutationInput, kind: "install" | "update" | "uninstall"): void {
  if (!CODEX_MUTATION_REQUEST_ID.test(input.requestId)) {
    throw new Error("Codex plugin mutation request ID is invalid");
  }
  if (typeof input.pluginId !== "string" || input.pluginId.length === 0 || input.pluginId.length > 200) {
    throw new Error("Codex plugin mutation plugin ID is invalid");
  }
  if (!CODEX_PLUGIN_ID.test(input.pluginId)) {
    throw new Error("Codex plugin mutation plugin ID is invalid");
  }
  if (typeof input.expectedRevision !== "string" || input.expectedRevision.length === 0) {
    throw new Error("Codex plugin mutation expected revision is invalid");
  }
  if (kind === "install" || kind === "update") {
    if (input.confirmFullTrust !== true) {
      throw new Error("Codex plugin install requires explicit full-trust confirmation");
    }
  }
  if (kind === "uninstall" && input.confirmRemoval !== true) {
    throw new Error("Codex plugin uninstall requires explicit removal confirmation");
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

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
