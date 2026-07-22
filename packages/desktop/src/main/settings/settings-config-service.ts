import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  SaveSettingsConfigInput,
  SaveSettingsConfigResult,
  SettingsConfigSnapshot,
} from "../../shared/settings-config-contracts.ts";

export const MISSING_SETTINGS_CONFIG_REVISION = "missing:settings-config-v1";

interface SettingsFileData {
  version?: number;
  showThinking?: boolean;
  [key: string]: unknown;
}

interface CurrentSettingsSource {
  exists: boolean;
  revision: string;
  data: SettingsFileData;
}

interface SettingsConfigServiceOptions {
  createId?(): string;
}

/** Owns reads and atomic writes for Desktop's userData/settings.json. */
export class SettingsConfigService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;

  constructor(userDataDir: string, options: SettingsConfigServiceOptions = {}) {
    this.path = join(userDataDir, "settings.json");
    this.createId = options.createId ?? randomUUID;
  }

  async getConfig(): Promise<SettingsConfigSnapshot> {
    return snapshotFromCurrent(this.path, await this.readCurrent());
  }

  saveConfig(input: SaveSettingsConfigInput): Promise<SaveSettingsConfigResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveSettingsConfigInput): Promise<SaveSettingsConfigResult> {
    assertSaveInputShape(input);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        return { status: "conflict", current: snapshotFromCurrent(this.path, current) };
      }
      const source = `${JSON.stringify({ ...current.data, version: 1, ...input.settings }, null, 2)}\n`;
      await this.atomicWrite(source);
      return { status: "saved", snapshot: snapshotFromCurrent(this.path, await this.readCurrent()) };
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentSettingsSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`settings.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { exists: false, revision: MISSING_SETTINGS_CONFIG_REVISION, data: {} };
      }
      throw error;
    }

    const bytes = await readFile(this.path);
    const source = bytes.toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("settings.json JSON syntax invalid");
    }
    if (!isPlainObject(value)) throw new Error("settings.json must be a JSON object");
    if (value.version !== undefined && value.version !== 1) throw new Error("settings.json version is unsupported");
    if (value.showThinking !== undefined && typeof value.showThinking !== "boolean") {
      throw new Error("settings.json showThinking must be a boolean");
    }
    return { exists: true, revision: hashBytes(bytes), data: value as SettingsFileData };
  }

  private async atomicWrite(source: string): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.settings.json.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(source, "utf8");
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

function snapshotFromCurrent(path: string, current: CurrentSettingsSource): SettingsConfigSnapshot {
  return {
    path,
    exists: current.exists,
    revision: current.revision,
    settings: { showThinking: current.data.showThinking ?? true },
  };
}

function assertSaveInputShape(input: SaveSettingsConfigInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !isPlainObject(input.settings) ||
    typeof input.settings.showThinking !== "boolean"
  ) {
    throw new TypeError("Invalid settings save input");
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
