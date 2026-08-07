/**
 * 内置浏览器（IAB）设置服务：读写 userDataDir/browser-settings.json。
 *
 * 与 auto-title/memory 设置服务同构：sha256 revision、lstat 拒 symlink、
 * proper-lockfile、临时文件 rename 原子写、未知高级字段保留、冲突返回
 * `{status:"conflict", current}`。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  BrowserSettingsSnapshot,
  SaveBrowserSettingsInput,
  SaveBrowserSettingsResult,
} from "../../shared/browser-settings-contracts.ts";
import { normalizeBrowserSettings, validateBrowserSettings } from "../../shared/browser-settings-contracts.ts";

export const MISSING_BROWSER_SETTINGS_REVISION = "missing:browser-settings-v1";

interface CurrentBrowserSettingsSource {
  exists: boolean;
  revision: string;
  data: Record<string, unknown>;
}

interface BrowserSettingsServiceOptions {
  createId?(): string;
  /** 覆盖默认 userDataDir/browser-settings.json（测试用）。 */
  path?: string;
}

/** Desktop 内置浏览器的设置服务。 */
export class BrowserSettingsService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;

  constructor(userDataDir: string, options: BrowserSettingsServiceOptions = {}) {
    this.path = options.path ?? join(userDataDir, "browser-settings.json");
    this.createId = options.createId ?? randomUUID;
  }

  async getSnapshot(): Promise<BrowserSettingsSnapshot> {
    return this.snapshotFromCurrent(await this.readCurrent());
  }

  saveConfig(input: SaveBrowserSettingsInput): Promise<SaveBrowserSettingsResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveBrowserSettingsInput): Promise<SaveBrowserSettingsResult> {
    assertSaveInput(input);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        return { status: "conflict", current: this.snapshotFromCurrent(current) };
      }
      const normalized = normalizeBrowserSettings(input.settings);
      // 保留未知高级字段，只覆盖已知字段（与 memory 设置服务一致）。
      const next = { ...current.data, ...normalized };
      const source = `${JSON.stringify(next, null, 2)}\n`;
      await this.atomicWrite(source);
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentBrowserSettingsSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`${this.path} is not a regular file`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { exists: false, revision: MISSING_BROWSER_SETTINGS_REVISION, data: {} };
      }
      throw error;
    }

    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${this.path} JSON syntax invalid`);
    }
    if (!isPlainObject(value)) throw new Error(`${this.path} must be a JSON object`);
    return { exists: true, revision: hashBytes(bytes), data: value as Record<string, unknown> };
  }

  private snapshotFromCurrent(current: CurrentBrowserSettingsSource): BrowserSettingsSnapshot {
    return {
      path: this.path,
      exists: current.exists,
      revision: current.revision,
      settings: normalizeBrowserSettings(current.data),
    };
  }

  private async atomicWrite(source: string): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.browser-settings.json.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.path);
      try {
        await chmod(this.path, 0o600);
      } catch {
        // best-effort
      }
      if (process.platform !== "win32") {
        try {
          const directoryHandle = await open(directory, "r");
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        } catch {
          // best-effort
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function assertSaveInput(input: SaveBrowserSettingsInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !input.settings ||
    typeof input.settings !== "object" ||
    validateBrowserSettings(input.settings).length > 0
  ) {
    throw new TypeError("Invalid browser settings save input");
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
