import type { Dirent } from "node:fs";
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { samePath } from "../../path-identity.ts";
import { assertCodexManagedChild, ensureCodexManagedDirectory } from "./codex-managed-paths.ts";
import { hashCodexPluginRoot } from "./codex-plugin-installer.ts";
import { withCodexPluginLock } from "./codex-plugin-lock.ts";
import type { CodexPluginRegistry } from "./codex-plugin-registry.ts";

interface CodexPluginReconcilerOptions {
  log?(message: string): void;
}

const VERSION_DIRECTORY = ".versions";
const ARTIFACT_HASH = /^[a-f0-9]{64}$/;
const CODEX_PLUGIN_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Startup reconciliation for Desktop-managed Codex plugin copies.
 *
 * The registry is the
 * single commit point): payloads that landed but never committed are removed,
 * and managed roots whose installed state is gone are torn down. Records that
 * claim an installed payload that no longer exists lose their installed state;
 * the source remains available for a reinstall.
 */
export class CodexPluginReconciler {
  private readonly registry: CodexPluginRegistry;
  private readonly codexRoot: string;
  private readonly lockDirectory: string;
  private readonly log: (message: string) => void;

  constructor(
    registry: CodexPluginRegistry,
    codexRoot: string,
    lockDirectory: string,
    options: CodexPluginReconcilerOptions = {},
  ) {
    this.registry = registry;
    this.codexRoot = codexRoot;
    this.lockDirectory = lockDirectory;
    this.log = options.log ?? (() => undefined);
  }

  async reconcile(): Promise<void> {
    const canonicalRoot = await ensureCodexManagedDirectory(this.codexRoot, dirname(dirname(this.codexRoot)));
    await this.cleanupOrphanStaging(canonicalRoot);
    const pluginIds = new Set((await this.managedRoots(canonicalRoot)).map((entry) => entry.name));
    for (const record of (await this.registry.getSnapshot()).plugins) {
      if (record.installedHash && record.installedRootPath) pluginIds.add(record.id);
    }
    for (const pluginId of pluginIds) {
      await withCodexPluginLock(this.lockDirectory, pluginId, async () => {
        await this.reconcileRoot(canonicalRoot, pluginId);
      });
    }
  }

  private async reconcileRoot(canonicalRoot: string, pluginId: string): Promise<void> {
    const rootPath = resolve(canonicalRoot, pluginId);
    assertCodexManagedChild(canonicalRoot, rootPath);
    const registered = (await this.registry.getSnapshot()).plugins.find((plugin) => plugin.id === pluginId);
    const installedHash = registered?.installedHash;
    const installedRootPath = registered?.installedRootPath;
    if (!installedHash || !installedRootPath) {
      await this.removeRoot(rootPath, pluginId);
      return;
    }
    if (!samePath(installedRootPath, rootPath)) return;
    const versionsRoot = join(rootPath, VERSION_DIRECTORY);
    const payloadPath = join(versionsRoot, installedHash);
    let exists = false;
    try {
      const versionsInfo = await lstat(versionsRoot);
      if (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink()) {
        throw new Error("Codex .versions path is not a regular directory");
      }
      const info = await lstat(payloadPath);
      exists =
        info.isDirectory() && !info.isSymbolicLink() && (await hashCodexPluginRoot(payloadPath)) === installedHash;
    } catch {
      exists = false;
    }
    if (!exists) {
      await this.registry
        .commitUninstalled((await this.registry.getSnapshot()).revision, pluginId)
        .catch(() => undefined);
      await this.removeRoot(rootPath, pluginId);
      this.log(`Removed Codex plugin managed copy with a missing payload for ${pluginId}`);
      return;
    }
    // 更新崩溃窗口：新 payload 已落位但注册未提交，或提交成功后旧 payload 删除失败。
    // 已提交记录下非当前 installedHash 的版本一律视为孤儿。
    await this.removeOrphanVersions(rootPath, installedHash, pluginId);
  }

  private async removeOrphanVersions(rootPath: string, installedHash: string, pluginId: string): Promise<void> {
    let versions: Dirent[];
    try {
      const versionsRoot = join(rootPath, VERSION_DIRECTORY);
      const info = await lstat(versionsRoot);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Codex .versions path is not a regular directory");
      versions = await readdir(versionsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const version of versions) {
      if (!version.isDirectory() || version.isSymbolicLink() || !ARTIFACT_HASH.test(version.name)) continue;
      if (version.name === installedHash) continue;
      await rm(join(rootPath, VERSION_DIRECTORY, version.name), { recursive: true, force: true });
      this.log(`Removed orphaned Codex plugin version payload for ${pluginId}: ${version.name}`);
    }
  }

  private async removeRoot(rootPath: string, pluginId: string): Promise<void> {
    try {
      const info = await lstat(rootPath);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (
      entries.length !== 1 ||
      entries[0]?.name !== VERSION_DIRECTORY ||
      !entries[0].isDirectory() ||
      entries[0].isSymbolicLink()
    )
      return;
    let versions: Dirent[];
    try {
      versions = await readdir(join(rootPath, VERSION_DIRECTORY), { withFileTypes: true });
    } catch {
      return;
    }
    if (versions.some((entry) => !entry.isDirectory() || !ARTIFACT_HASH.test(entry.name))) {
      return;
    }
    for (const version of versions) {
      await rm(join(rootPath, VERSION_DIRECTORY, version.name), { recursive: true, force: true });
    }
    await rmdir(join(rootPath, VERSION_DIRECTORY)).catch(() => undefined);
    await rmdir(rootPath).catch(() => undefined);
    this.log(`Removed uncommitted Codex plugin payload for ${pluginId}`);
  }

  private async cleanupOrphanStaging(canonicalRoot: string): Promise<void> {
    const stagingRoot = join(canonicalRoot, ".meta-agent-codex-staging");
    assertCodexManagedChild(canonicalRoot, stagingRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
    }
    await rmdir(stagingRoot).catch(() => undefined);
  }

  private async managedRoots(canonicalRoot: string): Promise<Dirent[]> {
    try {
      const entries = await readdir(canonicalRoot, { withFileTypes: true });
      return entries.filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && CODEX_PLUGIN_ID.test(entry.name),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
