import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type {
  AutoTitleModelOption,
  AutoTitleSettings,
  AutoTitleSettingsSnapshot,
  SaveAutoTitleSettingsInput,
  SaveAutoTitleSettingsResult,
} from "../../shared/auto-title-contracts.ts";
import {
  defaultAutoTitleSettings,
  normalizeAutoTitleSettings,
  validateAutoTitleSettings,
} from "../../shared/auto-title-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "../pi/desktop-builtin-provider.ts";

export const MISSING_AUTO_TITLE_REVISION = "missing:auto-title-config-v1";

interface CurrentAutoTitleSource {
  exists: boolean;
  revision: string;
  data: Record<string, unknown>;
}

interface AutoTitleSettingsServiceOptions {
  createId?(): string;
  /** Runtime model catalog; when provided, available models are offered in the settings UI. */
  modelRuntime?: ModelRuntime;
  /** Filters desktop built-in providers to those with configured auth. */
  isDesktopProviderAvailable?(providerId: string): Promise<boolean>;
}

/** Desktop-owned settings surface for the built-in pi-auto-title extension. */
export class AutoTitleSettingsService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;
  private readonly modelRuntime: ModelRuntime | undefined;
  private readonly isDesktopProviderAvailable: ((providerId: string) => Promise<boolean>) | undefined;

  constructor(agentDir: string, options: AutoTitleSettingsServiceOptions = {}) {
    this.path = join(agentDir, "auto-title-config.json");
    this.createId = options.createId ?? randomUUID;
    this.modelRuntime = options.modelRuntime;
    this.isDesktopProviderAvailable = options.isDesktopProviderAvailable;
  }

  async getSnapshot(): Promise<AutoTitleSettingsSnapshot> {
    return this.snapshotFromCurrent(await this.readCurrent());
  }

  /** Model options from desktop built-in providers and the runtime catalog, deduplicated. */
  async getModelOptions(): Promise<AutoTitleModelOption[]> {
    const desktopOptions = this.isDesktopProviderAvailable
      ? (
          await Promise.all(
            DesktopBuiltinProviderRegistry.getProviderInfos()
              .flatMap((provider) =>
                provider.models.map((model) => ({
                  provider: provider.id,
                  modelId: model.id,
                  name: model.name ?? model.id,
                })),
              )
              .map(async (option) => ((await this.isDesktopProviderAvailable!(option.provider)) ? [option] : [])),
          )
        ).flat()
      : [];
    const runtimeOptions = this.modelRuntime ? await this.runtimeModelOptions() : [];
    const merged = new Map<string, AutoTitleModelOption>();
    for (const option of [...desktopOptions, ...runtimeOptions]) {
      merged.set(`${option.provider}/${option.modelId}`, option);
    }
    return [...merged.values()].sort(
      (left, right) => left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId),
    );
  }

  private async runtimeModelOptions(): Promise<AutoTitleModelOption[]> {
    try {
      await this.modelRuntime!.refresh({ allowNetwork: false });
      return (await this.modelRuntime!.getAvailable()).map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name ?? model.id,
      }));
    } catch {
      // The runtime may be mid-refresh or have no resolvable catalog; an empty list keeps the UI usable.
      return [];
    }
  }

  saveConfig(input: SaveAutoTitleSettingsInput): Promise<SaveAutoTitleSettingsResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveAutoTitleSettingsInput): Promise<SaveAutoTitleSettingsResult> {
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
      const normalized = normalizeAutoTitleSettings(input.settings);
      const source = `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`;
      await this.atomicWrite(source);
      return { status: "saved", snapshot: await this.getSnapshot() };
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentAutoTitleSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`${this.path} is not a regular file`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { exists: false, revision: MISSING_AUTO_TITLE_REVISION, data: {} };
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

  private snapshotFromCurrent(current: CurrentAutoTitleSource): AutoTitleSettingsSnapshot {
    const defaults = defaultAutoTitleSettings();
    const data = current.data;
    const settings: AutoTitleSettings = {
      enabled: typeof data.enabled === "boolean" ? data.enabled : defaults.enabled,
      providerId: typeof data.providerId === "string" ? data.providerId.trim() : defaults.providerId,
      modelId: typeof data.modelId === "string" ? data.modelId.trim() : defaults.modelId,
      systemPrompt:
        typeof data.systemPrompt === "string" && data.systemPrompt.trim().length > 0
          ? data.systemPrompt.trim()
          : defaults.systemPrompt,
      maxLength:
        typeof data.maxLength === "number" && Number.isFinite(data.maxLength)
          ? Math.floor(data.maxLength)
          : defaults.maxLength,
    };
    return {
      path: this.path,
      exists: current.exists,
      revision: current.revision,
      settings: normalizeAutoTitleSettings(settings),
    };
  }

  private async atomicWrite(source: string): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.auto-title-config.json.${process.pid}.${this.createId()}.tmp`);
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

function assertSaveInput(input: SaveAutoTitleSettingsInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.expectedRevision !== "string" ||
    !input.settings ||
    typeof input.settings !== "object" ||
    validateAutoTitleSettings(input.settings).length > 0
  ) {
    throw new TypeError("Invalid auto title settings save input");
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
