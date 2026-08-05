import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  PreferencesSnapshot,
  SavePreferencesInput,
  SavePreferencesResult,
} from "../../shared/preferences-contracts.ts";
import { PREFERENCES_FILE_VERSION } from "../../shared/preferences-contracts.ts";

interface PreferencesFileData {
  version?: number;
  values?: Record<string, string>;
  [key: string]: unknown;
}

interface PreferencesConfigServiceOptions {
  createId?(): string;
}

/**
 * 持有 Desktop 的 userData/preferences.json。
 *
 * 与 settings.json 的区别：这是 renderer UI 偏好的持久化目标（替代 localStorage），
 * 值以字符串映射保存、由各偏好模块负责格式解析；损坏时回退为空而不是抛错，
 * 避免偏好文件问题阻塞应用启动。
 */
export class PreferencesConfigService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;

  constructor(userDataDir: string, options: PreferencesConfigServiceOptions = {}) {
    this.path = join(userDataDir, "preferences.json");
    this.createId = options.createId ?? randomUUID;
  }

  async getSnapshot(): Promise<PreferencesSnapshot> {
    return snapshotFromCurrent(this.path, await this.readCurrent());
  }

  /** 首帧初始化所需的同步读取（preload sendSync 路径），任何失败都回退为空快照。 */
  getInitial(): PreferencesSnapshot {
    try {
      const info = lstatSync(this.path);
      if (info.isSymbolicLink() || !info.isFile()) return emptySnapshot(this.path);
      const source = readFileSync(this.path, "utf8");
      return snapshotFromCurrent(this.path, parseCurrentSource(source));
    } catch {
      return emptySnapshot(this.path);
    }
  }

  save(input: SavePreferencesInput): Promise<SavePreferencesResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SavePreferencesInput): Promise<SavePreferencesResult> {
    if (!isSaveInputShape(input)) return { status: "failed", reason: "invalid save input" };
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(this.path, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
      });
      try {
        const current = await this.readCurrent();
        // 合并保存：未知键保留，renderer 的全量快照不会丢服务端已存在的值。
        const values = { ...current.data.values, ...input.values };
        const source = `${JSON.stringify({ ...current.data, version: PREFERENCES_FILE_VERSION, values }, null, 2)}\n`;
        await this.atomicWrite(source);
        return { status: "saved" };
      } finally {
        await release();
      }
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readCurrent(): Promise<{ exists: boolean; data: PreferencesFileData }> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`preferences.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { exists: false, data: {} };
      throw error;
    }

    const bytes = await readFile(this.path);
    const source = bytes.toString("utf8");
    return parseCurrentSource(source);
  }

  private async atomicWrite(source: string): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.preferences.json.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.path);
      // Post-rename chmod/dir-fsync are best-effort; failures must not roll back the write.
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

/** 解析并校验文件内容；语法或结构损坏时回退为空数据（与 settings.json 的抛错策略不同）。 */
function parseCurrentSource(source: string): { exists: boolean; data: PreferencesFileData } {
  const parsed: unknown = safeJsonParse(source);
  if (!isPlainObject(parsed)) return { exists: true, data: {} };
  if (parsed.version !== undefined && parsed.version !== PREFERENCES_FILE_VERSION) {
    return { exists: true, data: {} };
  }
  const rawValues = parsed.values;
  if (rawValues === undefined) return { exists: true, data: parsed as PreferencesFileData };
  if (!isPlainObject(rawValues)) return { exists: true, data: {} };
  const values: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rawValues)) {
    if (typeof entry === "string") values[key] = entry;
  }
  return { exists: true, data: { ...(parsed as PreferencesFileData), values } };
}

function safeJsonParse(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function snapshotFromCurrent(
  path: string,
  current: { exists: boolean; data: PreferencesFileData },
): PreferencesSnapshot {
  return { path, exists: current.exists, values: current.data.values ?? {} };
}

function emptySnapshot(path: string): PreferencesSnapshot {
  return { path, exists: false, values: {} };
}

function isSaveInputShape(input: SavePreferencesInput): boolean {
  return Boolean(input) && typeof input === "object" && isPlainObject(input.values);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
