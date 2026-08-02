import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
  clonePluginConfigurationSchema,
  defaultPluginConfigurationValues,
  type PluginConfigurationFieldError,
  type PluginConfigurationSchema,
  type PluginConfigurationSnapshot,
  type PluginConfigurationValue,
  type SavePluginConfigurationInput,
  type SavePluginConfigurationResult,
  validatePluginConfigurationValue,
} from "../../shared/plugin-configuration-contracts.ts";
import type { MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

export interface PluginConfigurationSecretStorage {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface PluginConfigurationFile {
  version?: number;
  values?: Record<string, PluginConfigurationValue>;
  secrets?: Record<string, string>;
  [key: string]: unknown;
}

interface CurrentPluginConfiguration {
  revision: string;
  data: PluginConfigurationFile;
}

interface PluginConfigurationServiceOptions {
  createId?(): string;
}

const PLUGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const DEVELOPMENT_PLUGIN_ID = /^development:[a-z0-9][a-z0-9._-]*$/;
const REQUEST_ID = /^[a-zA-Z0-9._-]{1,128}$/;
const MAX_REQUEST_RESULTS = 256;

interface ConfigurablePlugin {
  id: string;
  configurationSchema: PluginConfigurationSchema;
}

export class PluginConfigurationService {
  private readonly root: string;
  private readonly registry: MarketplacePluginRegistry;
  private readonly secretStorage: PluginConfigurationSecretStorage;
  private readonly createId: () => string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly requestResults = new Map<string, SavePluginConfigurationResult>();

  constructor(
    userDataDir: string,
    registry: MarketplacePluginRegistry,
    secretStorage: PluginConfigurationSecretStorage,
    options: PluginConfigurationServiceOptions = {},
  ) {
    this.root = join(userDataDir, "plugins", "configuration");
    this.registry = registry;
    this.secretStorage = secretStorage;
    this.createId = options.createId ?? randomUUID;
  }

  async getConfig(pluginId: string): Promise<PluginConfigurationSnapshot> {
    const plugin = await this.getConfigurablePlugin(pluginId);
    return this.getConfigFor(plugin, pluginId);
  }

  async getDevelopmentConfig(
    pluginId: string,
    schema: PluginConfigurationSchema,
  ): Promise<PluginConfigurationSnapshot> {
    assertDevelopmentPluginId(pluginId);
    return this.getConfigFor({ id: pluginId, configurationSchema: schema }, pluginId);
  }

  async getRuntimeConfiguration(
    pluginId: string,
  ): Promise<{ revision: string; values: Record<string, PluginConfigurationValue> }> {
    const plugin = await this.getConfigurablePlugin(pluginId);
    return this.getRuntimeConfigurationFor(plugin, pluginId);
  }

  async getDevelopmentRuntimeConfiguration(
    pluginId: string,
    schema: PluginConfigurationSchema,
  ): Promise<{ revision: string; values: Record<string, PluginConfigurationValue> }> {
    assertDevelopmentPluginId(pluginId);
    return this.getRuntimeConfigurationFor({ id: pluginId, configurationSchema: schema }, pluginId);
  }

  private async getConfigFor(plugin: ConfigurablePlugin, pluginId: string): Promise<PluginConfigurationSnapshot> {
    return this.snapshot(plugin, await this.readCurrent(pluginId));
  }

  private async getRuntimeConfigurationFor(
    plugin: ConfigurablePlugin,
    pluginId: string,
  ): Promise<{ revision: string; values: Record<string, PluginConfigurationValue> }> {
    const current = await this.readCurrent(pluginId);
    const schema = plugin.configurationSchema;
    const values = safeStoredPublicValues(schema, current.data.values ?? {});
    for (const field of schema.fields) {
      if (field.type !== "secret") continue;
      const encrypted = current.data.secrets?.[field.key];
      if (encrypted === undefined) continue;
      if (!this.secretStorage.isAvailable()) {
        throw new Error(`Secret storage is unavailable for plugin configuration: ${pluginId}`);
      }
      const value = this.secretStorage.decrypt(encrypted);
      const error = validatePluginConfigurationValue(field, value, true);
      if (error) throw new Error(`Stored plugin configuration is invalid: ${pluginId}.${field.key}`);
      values[field.key] = value;
    }
    for (const field of schema.fields) {
      const configured = field.type === "secret" && values[field.key] !== undefined;
      const error = validatePluginConfigurationValue(field, values[field.key], configured);
      if (error) throw new Error(`Plugin configuration is incomplete: ${pluginId}.${field.key}`);
    }
    return { revision: current.revision, values };
  }

  saveConfig(input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult> {
    assertSaveInput(input);
    const cacheKey = `${input.pluginId}\0${input.requestId}`;
    const cached = this.requestResults.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const operation = this.saveTail.then(async () => {
      const plugin = await this.getConfigurablePlugin(input.pluginId);
      return this.saveConfigLocked(input, cacheKey, plugin);
    });
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  saveDevelopmentConfig(
    input: SavePluginConfigurationInput,
    schema: PluginConfigurationSchema,
  ): Promise<SavePluginConfigurationResult> {
    assertSaveInput(input);
    assertDevelopmentPluginId(input.pluginId);
    const cacheKey = `${input.pluginId}\0${input.requestId}`;
    const cached = this.requestResults.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const operation = this.saveTail.then(() =>
      this.saveConfigLocked(input, cacheKey, { id: input.pluginId, configurationSchema: schema }),
    );
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(
    input: SavePluginConfigurationInput,
    cacheKey: string,
    plugin: ConfigurablePlugin,
  ): Promise<SavePluginConfigurationResult> {
    const path = this.pathFor(input.pluginId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent(input.pluginId);
      if (current.revision !== input.expectedRevision) {
        return this.cacheResult(cacheKey, {
          status: "conflict",
          current: this.snapshot(plugin, current),
        });
      }
      const prepared = this.prepareSave(plugin.configurationSchema, current.data, input);
      if (prepared.errors.length > 0) {
        return this.cacheResult(cacheKey, {
          status: "invalid",
          snapshot: this.snapshot(plugin, current),
          errors: prepared.errors,
        });
      }
      const next: PluginConfigurationFile = {
        ...current.data,
        version: 1,
        values: prepared.values,
        secrets: prepared.secrets,
      };
      if (!sameConfiguration(current.data, next)) await this.atomicWrite(path, next);
      return this.cacheResult(cacheKey, {
        status: "saved",
        snapshot: await this.getConfigFor(plugin, input.pluginId),
      });
    } finally {
      await release();
    }
  }

  private prepareSave(
    schema: PluginConfigurationSchema,
    current: PluginConfigurationFile,
    input: SavePluginConfigurationInput,
  ): {
    values: Record<string, PluginConfigurationValue>;
    secrets: Record<string, string>;
    errors: PluginConfigurationFieldError[];
  } {
    const fields = new Map(schema.fields.map((field) => [field.key, field]));
    const errors: PluginConfigurationFieldError[] = [];
    for (const key of Object.keys(input.values)) {
      const field = fields.get(key);
      if (!field || field.type === "secret") throw new Error(`Unknown non-secret plugin configuration field: ${key}`);
    }
    for (const key of Object.keys(input.secretValues ?? {})) {
      if (fields.get(key)?.type !== "secret") throw new Error(`Unknown secret plugin configuration field: ${key}`);
    }
    for (const key of input.clearSecrets ?? []) {
      if (fields.get(key)?.type !== "secret") throw new Error(`Unknown secret plugin configuration field: ${key}`);
    }

    const values = candidatePublicValues(schema, input.values);
    const secrets = { ...(current.secrets ?? {}) };
    for (const key of input.clearSecrets ?? []) delete secrets[key];
    for (const [key, value] of Object.entries(input.secretValues ?? {})) {
      if (!this.secretStorage.isAvailable()) {
        errors.push({
          field: key,
          code: "secret-storage",
          message: "系统凭据加密当前不可用，无法保存此敏感字段",
        });
        continue;
      }
      const field = fields.get(key)!;
      const error = validatePluginConfigurationValue(field, value, true);
      if (error) {
        errors.push(error);
        continue;
      }
      secrets[key] = this.secretStorage.encrypt(value);
    }
    const clearSet = new Set(input.clearSecrets ?? []);
    for (const field of schema.fields) {
      if (field.type === "secret") {
        const replacement = input.secretValues?.[field.key];
        const configured = replacement !== undefined || (!clearSet.has(field.key) && secrets[field.key] !== undefined);
        const error = validatePluginConfigurationValue(field, replacement, configured);
        if (error && !errors.some((candidate) => candidate.field === field.key)) errors.push(error);
        continue;
      }
      const error = validatePluginConfigurationValue(field, values[field.key]);
      if (error) errors.push(error);
    }
    return { values, secrets: selectKnownSecrets(schema, secrets), errors };
  }

  private snapshot(plugin: ConfigurablePlugin, current: CurrentPluginConfiguration): PluginConfigurationSnapshot {
    const schema = plugin.configurationSchema;
    const secrets: Record<string, boolean> = {};
    for (const field of schema.fields) {
      if (field.type === "secret") secrets[field.key] = current.data.secrets?.[field.key] !== undefined;
    }
    return {
      pluginId: plugin.id,
      revision: current.revision,
      schema: clonePluginConfigurationSchema(schema),
      values: safeStoredPublicValues(schema, current.data.values ?? {}),
      secrets,
      secretStorageAvailable: this.secretStorage.isAvailable(),
    };
  }

  private async getConfigurablePlugin(pluginId: string): Promise<ConfigurablePlugin> {
    if (!PLUGIN_ID.test(pluginId) || pluginId.length > 200) throw new Error("Plugin configuration ID is invalid");
    const plugin = (await this.registry.getInternalSnapshot()).plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin || plugin.state !== "installed") throw new Error(`Marketplace plugin is not installed: ${pluginId}`);
    if (!plugin.configurationSchema) throw new Error(`Marketplace plugin is not configurable: ${pluginId}`);
    return { id: plugin.id, configurationSchema: plugin.configurationSchema };
  }

  private pathFor(pluginId: string): string {
    const fileId = pluginId.startsWith("development:") ? encodeURIComponent(pluginId) : pluginId;
    return join(this.root, `${fileId}.json`);
  }

  private async readCurrent(pluginId: string): Promise<CurrentPluginConfiguration> {
    const path = this.pathFor(pluginId);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${path}`);
      if (!info.isFile()) throw new Error(`Plugin configuration is not a regular file: ${path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { revision: `missing:plugin-configuration-v1:${pluginId}`, data: {} };
      throw error;
    }
    const bytes = await readFile(path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Plugin configuration JSON syntax is invalid");
    }
    assertConfigurationFile(value);
    return { revision: createHash("sha256").update(bytes).digest("hex"), data: value };
  }

  private async atomicWrite(path: string, data: PluginConfigurationFile): Promise<void> {
    const directory = dirname(path);
    const tempPath = join(directory, `.configuration.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
      await chmod(path, 0o600);
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

  private cacheResult(cacheKey: string, result: SavePluginConfigurationResult): SavePluginConfigurationResult {
    if (this.requestResults.size >= MAX_REQUEST_RESULTS) {
      const oldest = this.requestResults.keys().next().value;
      if (typeof oldest === "string") this.requestResults.delete(oldest);
    }
    this.requestResults.set(cacheKey, result);
    return result;
  }
}

function candidatePublicValues(
  schema: PluginConfigurationSchema,
  input: Record<string, PluginConfigurationValue>,
): Record<string, PluginConfigurationValue> {
  const values = defaultPluginConfigurationValues(schema);
  for (const field of schema.fields) {
    if (field.type === "secret") continue;
    const value = input[field.key];
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

function safeStoredPublicValues(
  schema: PluginConfigurationSchema,
  input: Record<string, PluginConfigurationValue>,
): Record<string, PluginConfigurationValue> {
  const values = defaultPluginConfigurationValues(schema);
  for (const field of schema.fields) {
    if (field.type === "secret") continue;
    const value = input[field.key];
    if (value !== undefined && !validatePluginConfigurationValue(field, value)) values[field.key] = value;
  }
  return values;
}

function selectKnownSecrets(schema: PluginConfigurationSchema, input: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of schema.fields) {
    if (field.type === "secret" && input[field.key] !== undefined) secrets[field.key] = input[field.key]!;
  }
  return secrets;
}

function sameConfiguration(current: PluginConfigurationFile, next: PluginConfigurationFile): boolean {
  return (
    JSON.stringify(current.values ?? {}) === JSON.stringify(next.values ?? {}) &&
    JSON.stringify(current.secrets ?? {}) === JSON.stringify(next.secrets ?? {})
  );
}

function assertDevelopmentPluginId(pluginId: string): void {
  if (!DEVELOPMENT_PLUGIN_ID.test(pluginId) || pluginId.length > 200) {
    throw new Error("Development plugin configuration ID is invalid");
  }
}

function assertSaveInput(input: SavePluginConfigurationInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    !REQUEST_ID.test(input.requestId) ||
    typeof input.pluginId !== "string" ||
    typeof input.expectedRevision !== "string" ||
    !isPlainObject(input.values) ||
    (input.secretValues !== undefined && !isPlainObject(input.secretValues)) ||
    (input.clearSecrets !== undefined &&
      (!Array.isArray(input.clearSecrets) || !input.clearSecrets.every((key) => typeof key === "string")))
  ) {
    throw new TypeError("Invalid plugin configuration save input");
  }
  for (const value of Object.values(input.values)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TypeError("Plugin configuration values must be scalar");
    }
  }
  for (const value of Object.values(input.secretValues ?? {})) {
    if (typeof value !== "string") throw new TypeError("Plugin secret configuration values must be strings");
  }
}

function assertConfigurationFile(value: unknown): asserts value is PluginConfigurationFile {
  if (!isPlainObject(value)) throw new Error("Plugin configuration must be an object");
  if (value.version !== undefined && value.version !== 1)
    throw new Error("Plugin configuration version is unsupported");
  if (value.values !== undefined) {
    if (!isPlainObject(value.values)) throw new Error("Plugin configuration values must be an object");
    for (const item of Object.values(value.values)) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw new Error("Plugin configuration value is invalid");
      }
    }
  }
  if (value.secrets !== undefined) {
    if (!isPlainObject(value.secrets) || Object.values(value.secrets).some((item) => typeof item !== "string")) {
      throw new Error("Plugin configuration secrets are invalid");
    }
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
