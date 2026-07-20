import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { getModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { applyEdits, type FormattingOptions, modify, type ParseError, parse } from "jsonc-parser";
import lockfile from "proper-lockfile";
import type {
  AuthConfigDiagnostic,
  AuthConfigSnapshot,
  AuthEnvEntry,
  AuthProviderDraft,
  AuthProviderInfo,
  SaveAuthConfigInput,
  SaveAuthConfigResult,
} from "../../shared/auth-config-contracts.ts";

export const MISSING_AUTH_CONFIG_REVISION = "missing:auth-config-v1";
const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/i;

interface AuthFileEntry {
  type: "api_key" | "oauth";
  key?: string;
  env?: Record<string, string>;
  accessToken?: string;
  refreshToken?: string;
  expires?: number;
  [key: string]: unknown;
}

interface AuthFileData {
  [providerKey: string]: AuthFileEntry;
}

interface CurrentSource {
  exists: boolean;
  revision: string;
  source: string;
  data?: AuthFileData;
  diagnostics: AuthConfigDiagnostic[];
  sourceState: AuthConfigSnapshot["sourceState"];
  stats?: Stats;
}

interface AuthConfigServiceOptions {
  log?(message: string): void;
  now?(): number;
  createId?(): string;
}

/** Owns all reads and atomic writes for one agent directory's auth.json. */
export class AuthConfigService {
  readonly path: string;
  readonly agentDir: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly log?: (message: string) => void;
  private readonly createId: () => string;

  constructor(agentDir: string, options: AuthConfigServiceOptions = {}) {
    this.agentDir = agentDir;
    this.path = join(agentDir, "auth.json");
    this.log = options.log;
    this.createId = options.createId ?? randomUUID;
  }

  async getConfig(): Promise<AuthConfigSnapshot> {
    return snapshotFromCurrent(this.path, await this.readCurrent());
  }

  async getConfigRevision(): Promise<string> {
    return (await this.readCurrent()).revision;
  }

  async getExternalOpenTarget(): Promise<string> {
    return (await this.readCurrent()).exists ? this.path : this.agentDir;
  }

  saveConfig(input: SaveAuthConfigInput): Promise<SaveAuthConfigResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveAuthConfigInput): Promise<SaveAuthConfigResult> {
    assertSaveInputShape(input);
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await chmod(this.agentDir, 0o700);
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        this.writeLog("conflict", current, input.providers);
        return { status: "conflict", current: snapshotFromCurrent(this.path, current) };
      }
      if (current.sourceState === "invalid") {
        return { status: "invalid", diagnostics: current.diagnostics };
      }

      const currentData = current.data ?? {};
      const projected = projectDraft(input.providers, currentData);
      if (!projected.ok) return { status: "invalid", diagnostics: projected.diagnostics };

      const diagnostics: AuthConfigDiagnostic[] = [];
      for (const provider of input.providers) {
        if (provider.apiKey?.key) {
          const result = validateKeySyntax(provider.apiKey.key);
          if (!result.ok) {
            diagnostics.push({
              severity: "error",
              code: "auth.key-syntax",
              path: [provider.key, "key"],
              message: result.message,
            });
          }
        }
        if (provider.apiKey?.env) {
          for (const entry of provider.apiKey.env) {
            if (!entry.key || !VALID_ENV_KEY.test(entry.key)) {
              diagnostics.push({
                severity: "error",
                code: "auth.env-key",
                path: [provider.key, "env", entry.key],
                message: `环境变量名 "${entry.key}" 无效`,
              });
            }
          }
        }
      }
      if (diagnostics.some((d) => d.severity === "error")) {
        return { status: "invalid", diagnostics };
      }

      const candidate = serializeConfig(projected.config, current);
      await this.atomicWrite(candidate);
      const saved = await this.readCurrent();
      this.writeLog("saved", saved, input.providers);
      return { status: "saved", snapshot: snapshotFromCurrent(this.path, saved) };
    } finally {
      await release();
    }
  }

  private async readCurrent(): Promise<CurrentSource> {
    let stats: Stats;
    try {
      stats = await lstat(this.path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {
          exists: false,
          revision: MISSING_AUTH_CONFIG_REVISION,
          source: "",
          diagnostics: [],
          sourceState: "missing",
        };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
    if (!stats.isFile()) throw new Error(`auth.json is not a regular file: ${this.path}`);

    const bytes = await readFile(this.path);
    const source = bytes.toString("utf8");
    const revision = hashBytes(bytes);
    const parseErrors: ParseError[] = [];
    const parsedValue = parse(source, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0 || !isPlainObject(parsedValue)) {
      return {
        exists: true,
        revision,
        source,
        diagnostics: [
          {
            severity: "error",
            code: "syntax.invalid",
            path: [],
            message: parseErrors.length > 0 ? "auth.json JSONC 语法无效" : "auth.json must be a JSON object",
          },
        ],
        sourceState: "invalid",
        stats,
      };
    }

    const schemaDiagnostics = validateAuthFileData(parsedValue);
    if (schemaDiagnostics.length > 0) {
      return {
        exists: true,
        revision,
        source,
        diagnostics: schemaDiagnostics,
        sourceState: "invalid",
        stats,
      };
    }

    return {
      exists: true,
      revision,
      source,
      data: parsedValue as AuthFileData,
      diagnostics: [],
      sourceState: "valid",
      stats,
    };
  }

  private async atomicWrite(source: string): Promise<void> {
    const tempPath = join(dirname(this.path), `.auth.json.${process.pid}.${this.createId()}.tmp`);
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
        const directory = await open(this.agentDir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private writeLog(result: string, current: CurrentSource, providers: AuthProviderDraft[]): void {
    if (!this.log) return;
    this.log(
      `auth config ${result}: path=${this.path} revision=${current.revision.slice(0, 12)} providers=${providers.length}`,
    );
  }
}

interface DraftProjectionSuccess {
  ok: true;
  config: AuthFileData;
}

interface DraftProjectionFailure {
  ok: false;
  diagnostics: AuthConfigDiagnostic[];
}

function projectDraft(
  providers: AuthProviderDraft[],
  current: AuthFileData,
): DraftProjectionSuccess | DraftProjectionFailure {
  const diagnostics: AuthConfigDiagnostic[] = [];
  const providerKeys = new Set<string>();
  const nextConfig: AuthFileData = {};

  for (const provider of providers) {
    const key = provider.key.trim();
    if (!key || key === "__proto__" || providerKeys.has(key)) {
      diagnostics.push(inputDiagnostic([provider.key], "Provider key 不能为空且必须唯一。"));
      continue;
    }
    providerKeys.add(key);
    const origin = provider.origin ?? key;
    const currentEntry = current[origin];

    if (provider.apiKey) {
      // An empty key means remove the stored credential, allowing ambient auth to work again.
      if (!provider.apiKey.key) continue;
      const entry: AuthFileEntry =
        currentEntry?.type === "api_key" ? { ...currentEntry, type: "api_key" } : { type: "api_key" };
      entry.key = provider.apiKey.key;
      delete entry.env;
      if (provider.apiKey.env && provider.apiKey.env.length > 0) {
        const env: Record<string, string> = {};
        for (const envEntry of provider.apiKey.env) {
          if (envEntry.key) env[envEntry.key] = envEntry.value;
        }
        if (Object.keys(env).length > 0) entry.env = env;
      }
      nextConfig[key] = entry;
    } else if (provider.oauth && currentEntry?.type === "oauth") {
      // OAuth tokens are opaque to the renderer and are copied unchanged.
      nextConfig[key] = { ...currentEntry };
    }
  }

  return { ok: true, config: nextConfig };
}

function serializeConfig(config: AuthFileData, current: CurrentSource): string {
  if (!current.exists) {
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  return applyValueDiff(current.source, current.data ?? {}, config);
}

function validateKeySyntax(key: string): { ok: true } | { ok: false; message: string } {
  if (key.length === 0) return { ok: false, message: "API key 不能为空" };
  if (key.startsWith("!")) {
    const command = key.slice(1);
    if (!command.trim() || command.startsWith("!")) {
      return { ok: false, message: "!command 格式无效：命令不能为空或以 ! 开头" };
    }
    return { ok: true };
  }

  for (let index = 0; index < key.length; index += 1) {
    if (key[index] !== "$") continue;
    const next = key[index + 1];
    if (next === "$" || next === "!") {
      index += 1;
      continue;
    }
    if (next === "{") {
      const close = key.indexOf("}", index + 2);
      if (close < 0) return { ok: false, message: "环境变量模板括号不匹配" };
      const name = key.slice(index + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return { ok: false, message: "环境变量名格式无效" };
      }
      index = close;
      continue;
    }
    if (next && /^[A-Za-z_]$/.test(next)) {
      index += 1;
      while (index + 1 < key.length && /^[A-Za-z0-9_]$/.test(key[index + 1]!)) index += 1;
      continue;
    }
    return { ok: false, message: `环境变量引用格式无效：使用 $ENV、\${ENV} 或 $$/$! 转义` };
  }
  return { ok: true };
}

function validateAuthFileData(value: Record<string, unknown>): AuthConfigDiagnostic[] {
  const diagnostics: AuthConfigDiagnostic[] = [];
  for (const [providerKey, rawEntry] of Object.entries(value)) {
    const path = [providerKey];
    if (providerKey === "__proto__" || !isPlainObject(rawEntry)) {
      diagnostics.push({
        severity: "error",
        code: "schema.provider",
        path,
        message: "Provider credential 必须是对象。",
      });
      continue;
    }
    if (rawEntry.type === "api_key") {
      if (typeof rawEntry.key !== "string" || rawEntry.key.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "schema.api-key",
          path: [...path, "key"],
          message: "API key 必须是非空字符串。",
        });
      }
      if (rawEntry.env !== undefined && !isPlainObject(rawEntry.env)) {
        diagnostics.push({
          severity: "error",
          code: "schema.env",
          path: [...path, "env"],
          message: "env 必须是字符串映射。",
        });
      } else if (isPlainObject(rawEntry.env)) {
        for (const [envKey, envValue] of Object.entries(rawEntry.env)) {
          if (!VALID_ENV_KEY.test(envKey) || typeof envValue !== "string") {
            diagnostics.push({
              severity: "error",
              code: "schema.env",
              path: [...path, "env", envKey],
              message: "环境变量覆盖必须使用有效变量名和字符串值。",
            });
          }
        }
      }
      continue;
    }
    if (rawEntry.type === "oauth") {
      if (typeof rawEntry.accessToken !== "string" || typeof rawEntry.expires !== "number") {
        diagnostics.push({
          severity: "error",
          code: "schema.oauth",
          path,
          message: "OAuth credential 缺少有效的 accessToken 或 expires。",
        });
      }
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "schema.credential",
      path: [...path, "type"],
      message: "credential type 必须是 api_key 或 oauth。",
    });
  }
  return diagnostics;
}

function applyValueDiff(source: string, current: unknown, desired: unknown): string {
  let nextSource = source;
  const formatting = detectFormatting(source);
  const apply = (path: Array<string | number>, before: unknown, after: unknown): void => {
    if (isDeepStrictEqual(before, after)) return;
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) {
          nextSource = applyEdits(
            nextSource,
            modify(nextSource, [...path, key], undefined, { formattingOptions: formatting }),
          );
        }
      }
      for (const [key, value] of Object.entries(after)) {
        if (Object.hasOwn(before, key)) apply([...path, key], before[key], value);
        else
          nextSource = applyEdits(
            nextSource,
            modify(nextSource, [...path, key], value, { formattingOptions: formatting }),
          );
      }
      return;
    }
    nextSource = applyEdits(nextSource, modify(nextSource, path, after, { formattingOptions: formatting }));
  };
  apply([], current, desired);
  return nextSource;
}

function detectFormatting(source: string): FormattingOptions {
  const eol = source.includes("\\r\\n") ? "\\r\\n" : "\\n";
  const indent = source.match(/\\n([\\t ]+)"/)?.[1] ?? "  ";
  return indent.includes("\\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: Math.max(1, indent.length), eol };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function knownProviders(): AuthProviderInfo[] {
  try {
    const metadata = getModelsConfigMetadata();
    return metadata.builtInProviders.map((provider) => {
      const envKeys = findEnvKeys(provider.id) ?? [];
      return {
        id: provider.id,
        displayName: provider.displayName,
        envKeys,
      };
    });
  } catch {
    return [];
  }
}

function snapshotFromCurrent(path: string, current: CurrentSource): AuthConfigSnapshot {
  const data = current.data ?? {};
  const providers = current.sourceState === "valid" ? configToDraft(data) : [];
  return {
    path,
    exists: current.exists,
    revision: current.revision,
    sourceState: current.sourceState,
    providers,
    diagnostics: current.diagnostics,
    knownProviders: knownProviders(),
  };
}

function configToDraft(data: AuthFileData): AuthProviderDraft[] {
  return Object.entries(data)
    .filter(([key]) => key !== "__proto__" && !key.startsWith("_"))
    .map(([key, entry]) => {
      const draft: AuthProviderDraft = { key, origin: key };

      if (entry.type === "api_key") {
        const envEntries: AuthEnvEntry[] = [];
        if (entry.env) {
          for (const [envKey, envValue] of Object.entries(entry.env)) {
            envEntries.push({ key: envKey, value: envValue });
          }
        }
        draft.apiKey = {
          key: entry.key ?? "",
          env: envEntries.length > 0 ? envEntries : undefined,
        };
      } else if (entry.type === "oauth" || entry.accessToken) {
        const providerName = key;
        const expires = entry.expires;
        draft.oauth = {
          providerName,
          expires: expires ? new Date(expires).toISOString() : "unknown",
          expired: expires ? Date.now() > expires : false,
        };
      } else {
        // Unknown or missing type, treat as api_key with empty key
        draft.apiKey = { key: "" };
      }

      return draft;
    });
}

function assertSaveInputShape(input: SaveAuthConfigInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.expectedRevision !== "string" ||
    !Array.isArray(input.providers)
  ) {
    throw new TypeError("Invalid auth save input");
  }
  for (const provider of input.providers) {
    if (!isPlainObject(provider) || typeof provider.key !== "string") {
      throw new TypeError("Invalid provider draft");
    }
    if (provider.origin !== undefined && typeof provider.origin !== "string") {
      throw new TypeError("Invalid provider origin");
    }
    if (provider.apiKey !== undefined) {
      if (!isPlainObject(provider.apiKey) || typeof provider.apiKey.key !== "string") {
        throw new TypeError("Invalid API key draft");
      }
      if (provider.apiKey.env !== undefined) {
        if (!Array.isArray(provider.apiKey.env)) throw new TypeError("Invalid env draft");
        for (const entry of provider.apiKey.env) {
          if (!isPlainObject(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
            throw new TypeError("Invalid env entry draft");
          }
        }
      }
    }
    if (provider.oauth !== undefined && !isPlainObject(provider.oauth)) {
      throw new TypeError("Invalid OAuth draft");
    }
  }
}

function inputDiagnostic(path: readonly (string | number)[], message: string): AuthConfigDiagnostic {
  return { severity: "error", code: "input.invalid", path, message };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
