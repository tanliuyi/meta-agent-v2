import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  DesktopExtensionDefinition,
  DesktopExtensionSettingsSnapshot,
  SaveDesktopExtensionSettingsInput,
  SaveDesktopExtensionSettingsResult,
} from "../../shared/desktop-extension-contracts.ts";

export const MISSING_DESKTOP_EXTENSION_SETTINGS_REVISION = "missing:desktop-extensions-v1";

export interface StoredDevelopmentExtension {
  id: string;
  displayName: string;
  entryPath: string;
  enabled: boolean;
}

export interface InternalDesktopExtensionSettings {
  revision: string;
  developerMode: boolean;
  curatedEnabled: Record<string, boolean>;
  developmentEntries: StoredDevelopmentExtension[];
}

interface ExtensionSettingsFileData {
  version?: number;
  developerMode?: boolean;
  curatedEnabled?: Record<string, boolean>;
  developmentEntries?: StoredDevelopmentExtension[];
  [key: string]: unknown;
}

interface CurrentExtensionSettingsSource {
  exists: boolean;
  revision: string;
  data: ExtensionSettingsFileData;
}

interface DesktopExtensionSettingsServiceOptions {
  createId?(): string;
  builtinDefinitions?: DesktopExtensionDefinition[];
  curatedDefinitions?: DesktopExtensionDefinition[];
}

const ALLOWED_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);

/** Owns Desktop-controlled extension approvals and never exposes loadable paths to renderer snapshots. */
export class DesktopExtensionSettingsService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;
  private readonly builtinDefinitions: DesktopExtensionDefinition[];
  private readonly curatedDefinitions: DesktopExtensionDefinition[];
  private readonly requestResults = new Map<string, SaveDesktopExtensionSettingsResult>();
  private reloadRequired = false;

  constructor(userDataDir: string, options: DesktopExtensionSettingsServiceOptions = {}) {
    this.path = join(userDataDir, "extensions.json");
    this.createId = options.createId ?? randomUUID;
    this.builtinDefinitions = options.builtinDefinitions ?? [];
    this.curatedDefinitions = options.curatedDefinitions ?? [];
  }

  async getConfig(): Promise<DesktopExtensionSettingsSnapshot> {
    return this.snapshot(await this.readCurrent());
  }

  async getInternalConfig(): Promise<InternalDesktopExtensionSettings> {
    const current = await this.readCurrent();
    return internalFromCurrent(current);
  }

  saveConfig(input: SaveDesktopExtensionSettingsInput): Promise<SaveDesktopExtensionSettingsResult> {
    const cached = this.requestResults.get(input.requestId);
    if (cached) return Promise.resolve(cached);
    return this.enqueue(() => this.saveConfigLocked(input));
  }

  approveDevelopmentEntry(
    input: { requestId: string; expectedRevision: string },
    selectedPath: string | undefined,
  ): Promise<SaveDesktopExtensionSettingsResult> {
    const cached = this.requestResults.get(input.requestId);
    if (cached) return Promise.resolve(cached);
    return this.enqueue(() => this.approveDevelopmentEntryLocked(input, selectedPath));
  }

  private enqueue(
    operation: () => Promise<SaveDesktopExtensionSettingsResult>,
  ): Promise<SaveDesktopExtensionSettingsResult> {
    const pending = this.saveTail.then(operation);
    this.saveTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async saveConfigLocked(
    input: SaveDesktopExtensionSettingsInput,
  ): Promise<SaveDesktopExtensionSettingsResult> {
    assertMutationInput(input);
    return this.withLock(async () => {
      const cached = this.requestResults.get(input.requestId);
      if (cached) return cached;
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        const result: SaveDesktopExtensionSettingsResult = { status: "conflict", current: this.snapshot(current) };
        this.requestResults.set(input.requestId, result);
        return result;
      }
      const internal = internalFromCurrent(current);
      const data = applyMutation(current.data, internal, input, this.curatedDefinitions);
      if (!data) {
        const result: SaveDesktopExtensionSettingsResult = { status: "saved", snapshot: this.snapshot(current) };
        this.requestResults.set(input.requestId, result);
        return result;
      }
      await this.atomicWrite(data);
      this.reloadRequired = true;
      const result: SaveDesktopExtensionSettingsResult = { status: "saved", snapshot: await this.getConfig() };
      this.requestResults.set(input.requestId, result);
      return result;
    });
  }

  private async approveDevelopmentEntryLocked(
    input: { requestId: string; expectedRevision: string },
    selectedPath: string | undefined,
  ): Promise<SaveDesktopExtensionSettingsResult> {
    if (!input || typeof input.requestId !== "string" || typeof input.expectedRevision !== "string") {
      throw new TypeError("Invalid development extension approval input");
    }
    if (!selectedPath) {
      const result: SaveDesktopExtensionSettingsResult = { status: "cancelled", snapshot: await this.getConfig() };
      this.requestResults.set(input.requestId, result);
      return result;
    }
    const canonicalPath = await validateDevelopmentEntry(selectedPath);
    return this.withLock(async () => {
      const cached = this.requestResults.get(input.requestId);
      if (cached) return cached;
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        const result: SaveDesktopExtensionSettingsResult = { status: "conflict", current: this.snapshot(current) };
        this.requestResults.set(input.requestId, result);
        return result;
      }
      const internal = internalFromCurrent(current);
      const existing = internal.developmentEntries.find((entry) => entry.entryPath === canonicalPath);
      if (existing?.enabled) {
        const result: SaveDesktopExtensionSettingsResult = { status: "saved", snapshot: this.snapshot(current) };
        this.requestResults.set(input.requestId, result);
        return result;
      }
      const developmentEntries = existing
        ? internal.developmentEntries.map((entry) => (entry.id === existing.id ? { ...entry, enabled: true } : entry))
        : [
            ...internal.developmentEntries,
            {
              id: `development:${this.createId()}`,
              displayName: basename(canonicalPath),
              entryPath: canonicalPath,
              enabled: true,
            },
          ];
      await this.atomicWrite({
        ...current.data,
        version: 1,
        developerMode: internal.developerMode,
        curatedEnabled: internal.curatedEnabled,
        developmentEntries,
      });
      this.reloadRequired = true;
      const result: SaveDesktopExtensionSettingsResult = { status: "saved", snapshot: await this.getConfig() };
      this.requestResults.set(input.requestId, result);
      return result;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentExtensionSettingsSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`extensions.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { exists: false, revision: MISSING_DESKTOP_EXTENSION_SETTINGS_REVISION, data: {} };
      }
      throw error;
    }
    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("extensions.json JSON syntax invalid");
    }
    assertSettingsFile(value);
    return { exists: true, revision: hashBytes(bytes), data: value };
  }

  private snapshot(current: CurrentExtensionSettingsSource): DesktopExtensionSettingsSnapshot {
    const internal = internalFromCurrent(current);
    const builtin = this.builtinDefinitions.map((definition) => ({
      id: definition.id,
      displayName: definition.displayName,
      source: definition.source,
      enabled: true,
      configuredEnabled: true,
      capabilities: [...definition.capabilities],
    }));
    const curated = this.curatedDefinitions.map((definition) => {
      const configuredEnabled = internal.curatedEnabled[definition.id] ?? true;
      return {
        id: definition.id,
        displayName: definition.displayName,
        source: definition.source,
        enabled: configuredEnabled,
        configuredEnabled,
        capabilities: [...definition.capabilities],
      };
    });
    const development = internal.developmentEntries.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      source: "development" as const,
      enabled: internal.developerMode && entry.enabled,
      configuredEnabled: entry.enabled,
      capabilities: [],
      displayPath: basename(entry.entryPath),
    }));
    return {
      revision: current.revision,
      developerMode: internal.developerMode,
      reloadRequired: this.reloadRequired,
      diagnostics: [],
      entries: [...builtin, ...curated, ...development],
    };
  }

  private async atomicWrite(data: ExtensionSettingsFileData): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.extensions.json.${process.pid}.${this.createId()}.tmp`);
    const source = `${JSON.stringify(data, null, 2)}\n`;
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

function applyMutation(
  current: ExtensionSettingsFileData,
  internal: InternalDesktopExtensionSettings,
  input: SaveDesktopExtensionSettingsInput,
  curatedDefinitions: DesktopExtensionDefinition[],
): ExtensionSettingsFileData | undefined {
  let developerMode = internal.developerMode;
  const curatedEnabled = { ...internal.curatedEnabled };
  let developmentEntries = internal.developmentEntries.map((entry) => ({ ...entry }));
  const mutation = input.mutation;
  switch (mutation.type) {
    case "set-developer-mode":
      if (developerMode === mutation.enabled) return undefined;
      developerMode = mutation.enabled;
      break;
    case "set-curated-enabled":
      if (!curatedDefinitions.some((definition) => definition.id === mutation.extensionId)) {
        throw new Error(`Unknown curated extension: ${mutation.extensionId}`);
      }
      if ((curatedEnabled[mutation.extensionId] ?? true) === mutation.enabled) return undefined;
      curatedEnabled[mutation.extensionId] = mutation.enabled;
      break;
    case "set-development-enabled": {
      let found = false;
      let changed = false;
      developmentEntries = developmentEntries.map((entry) => {
        if (entry.id !== mutation.extensionId) return entry;
        found = true;
        changed = entry.enabled !== mutation.enabled;
        return changed ? { ...entry, enabled: mutation.enabled } : entry;
      });
      if (!found) throw new Error(`Unknown development extension: ${mutation.extensionId}`);
      if (!changed) return undefined;
      break;
    }
    case "remove-development-entry": {
      const next = developmentEntries.filter((entry) => entry.id !== mutation.extensionId);
      if (next.length === developmentEntries.length) {
        throw new Error(`Unknown development extension: ${mutation.extensionId}`);
      }
      developmentEntries = next;
      break;
    }
  }
  return { ...current, version: 1, developerMode, curatedEnabled, developmentEntries };
}

function internalFromCurrent(current: CurrentExtensionSettingsSource): InternalDesktopExtensionSettings {
  return {
    revision: current.revision,
    developerMode: current.data.developerMode ?? false,
    curatedEnabled: { ...(current.data.curatedEnabled ?? {}) },
    developmentEntries: (current.data.developmentEntries ?? []).map((entry) => ({ ...entry })),
  };
}

async function validateDevelopmentEntry(selectedPath: string): Promise<string> {
  if (!ALLOWED_ENTRY_EXTENSIONS.has(extname(selectedPath).toLowerCase())) {
    throw new Error("Development extension entry must be a JavaScript or TypeScript file");
  }
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Development extension entry must be a regular non-symlink file");
  }
  return realpath(selectedPath);
}

function assertMutationInput(input: SaveDesktopExtensionSettingsInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.requestId !== "string" ||
    typeof input.expectedRevision !== "string" ||
    !input.mutation ||
    typeof input.mutation !== "object"
  ) {
    throw new TypeError("Invalid extension settings mutation input");
  }
}

function assertSettingsFile(value: unknown): asserts value is ExtensionSettingsFileData {
  if (!isPlainObject(value)) throw new Error("extensions.json must be a JSON object");
  if (value.version !== undefined && value.version !== 1) throw new Error("extensions.json version is unsupported");
  if (value.developerMode !== undefined && typeof value.developerMode !== "boolean") {
    throw new Error("extensions.json developerMode must be boolean");
  }
  if (value.curatedEnabled !== undefined) {
    if (!isPlainObject(value.curatedEnabled)) throw new Error("extensions.json curatedEnabled must be an object");
    for (const enabled of Object.values(value.curatedEnabled)) {
      if (typeof enabled !== "boolean") throw new Error("extensions.json curatedEnabled values must be boolean");
    }
  }
  if (value.developmentEntries !== undefined) {
    if (!Array.isArray(value.developmentEntries)) {
      throw new Error("extensions.json developmentEntries must be an array");
    }
    for (const entry of value.developmentEntries) {
      if (
        !isPlainObject(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.displayName !== "string" ||
        typeof entry.entryPath !== "string" ||
        typeof entry.enabled !== "boolean"
      ) {
        throw new Error("extensions.json development entry is invalid");
      }
    }
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
