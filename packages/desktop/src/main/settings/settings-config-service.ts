import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  SaveSettingsConfigInput,
  SaveSettingsConfigResult,
  SettingsConfigSnapshot,
} from "../../shared/settings-config-contracts.ts";
import {
  clampMessageWidth,
  DEFAULT_USER_NAME,
  MESSAGE_WIDTH_DEFAULT,
  USER_NAME_MAX_LENGTH,
} from "../../shared/settings-config-contracts.ts";

export const MISSING_SETTINGS_CONFIG_REVISION = "missing:settings-config-v1";

interface SettingsFileData {
  version?: number;
  showThinking?: boolean;
  autoExpandRunning?: boolean;
  showAvatars?: boolean;
  messageWidth?: number | null;
  userName?: string;
  userAvatarPath?: string | null;
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
      const source = `${JSON.stringify({ ...current.data, version: 1, ...normalizeSettingsForSave(input.settings) }, null, 2)}\n`;
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
    if (value.autoExpandRunning !== undefined && typeof value.autoExpandRunning !== "boolean") {
      throw new Error("settings.json autoExpandRunning must be a boolean");
    }
    if (value.showAvatars !== undefined && typeof value.showAvatars !== "boolean") {
      throw new Error("settings.json showAvatars must be a boolean");
    }
    if (
      value.messageWidth !== undefined &&
      value.messageWidth !== null &&
      (typeof value.messageWidth !== "number" || !Number.isFinite(value.messageWidth))
    ) {
      throw new Error("settings.json messageWidth must be a finite number or null");
    }
    if (value.userName !== undefined && !isValidUserName(value.userName)) {
      throw new Error("settings.json userName must be a non-empty string of at most 80 characters");
    }
    if (value.userAvatarPath !== undefined && !isValidUserAvatarPath(value.userAvatarPath)) {
      throw new Error("settings.json userAvatarPath must be an absolute PNG, JPEG, or WebP path, or null");
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

function normalizeSettingsForSave(settings: SaveSettingsConfigInput["settings"]): SaveSettingsConfigInput["settings"] {
  return {
    ...settings,
    messageWidth: settings.messageWidth === null ? null : clampMessageWidth(settings.messageWidth),
  };
}

function snapshotFromCurrent(path: string, current: CurrentSettingsSource): SettingsConfigSnapshot {
  return {
    path,
    exists: current.exists,
    revision: current.revision,
    settings: {
      showThinking: current.data.showThinking ?? true,
      autoExpandRunning: current.data.autoExpandRunning ?? true,
      showAvatars: current.data.showAvatars ?? true,
      messageWidth: normalizeStoredMessageWidth(current.data.messageWidth),
      userName: current.data.userName ?? DEFAULT_USER_NAME,
      userAvatarPath: current.data.userAvatarPath ?? null,
    },
  };
}

function assertSaveInputShape(input: SaveSettingsConfigInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !isPlainObject(input.settings) ||
    typeof input.settings.showThinking !== "boolean" ||
    typeof input.settings.autoExpandRunning !== "boolean" ||
    typeof input.settings.showAvatars !== "boolean" ||
    (input.settings.messageWidth !== null &&
      (typeof input.settings.messageWidth !== "number" || !Number.isFinite(input.settings.messageWidth))) ||
    !isValidUserName(input.settings.userName) ||
    !isValidUserAvatarPath(input.settings.userAvatarPath)
  ) {
    throw new TypeError("Invalid settings save input");
  }
}

function isValidUserName(value: unknown): value is string {
  return (
    typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= USER_NAME_MAX_LENGTH
  );
}

export function isValidUserAvatarPath(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !isAbsolute(value)) return false;
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(value).toLowerCase());
}

/** 缺失时用默认宽度，null（满屏）原样保留，数值夹取到支持范围。 */
function normalizeStoredMessageWidth(value: number | null | undefined): number | null {
  if (value === undefined) return MESSAGE_WIDTH_DEFAULT;
  return value === null ? null : clampMessageWidth(value);
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
