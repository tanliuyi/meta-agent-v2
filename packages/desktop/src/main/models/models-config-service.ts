import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  formatModelsConfigDiagnostics,
  getModelsConfigMetadata,
  type ModelsCompat,
  type ModelsConfig,
  type ModelsModelDefinition,
  type ModelsModelOverride,
  type ModelsProviderConfig,
  type ModelsConfigDiagnostic as PiModelsConfigDiagnostic,
  parseModelsConfigSource,
  validateModelsConfigValue,
} from "@earendil-works/pi-coding-agent/models-config";
import { applyEdits, type FormattingOptions, findNodeAtLocation, modify, type Node, parseTree } from "jsonc-parser";
import lockfile from "proper-lockfile";
import type {
  ModelsCompatDraft,
  ModelsConfigDiagnostic,
  ModelsConfigPath,
  ModelsConfigSnapshot,
  ModelsMapEntryDraft,
  ModelsModelDraft,
  ModelsModelOverrideDraft,
  ModelsProviderDraft,
  SaveModelsConfigInput,
  SaveModelsConfigResult,
} from "../../shared/models-config-contracts.ts";

export const MISSING_MODELS_CONFIG_REVISION = "missing:models-config-v1";

const PROVIDER_KEYS = ["name", "baseUrl", "apiKey", "api", "oauth", "authHeader"] as const;
const MODEL_KEYS = [
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
] as const;
const OVERRIDE_KEYS = ["name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens"] as const;
const COMPAT_KEYS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "cacheControlFormat",
  "openRouterRouting",
  "vercelGatewayRouting",
  "zaiToolStream",
  "supportsStrictMode",
  "sendSessionAffinityHeaders",
  "sessionAffinityFormat",
  "supportsLongCacheRetention",
  "supportsToolSearch",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsToolReferences",
] as const;
const PROVIDER_ALL_KEYS = new Set<string>([...PROVIDER_KEYS, "headers", "compat", "models", "modelOverrides"]);
const MODEL_ALL_KEYS = new Set<string>([...MODEL_KEYS, "headers", "compat"]);
const OVERRIDE_ALL_KEYS = new Set<string>([...OVERRIDE_KEYS, "headers", "compat"]);
const COMPAT_ALL_KEYS = new Set<string>([...COMPAT_KEYS, "chatTemplateKwargs"]);
const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers"]);
const COST_TIER_KEYS = new Set(["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"]);
const THINKING_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OPEN_ROUTER_KEYS = new Set([
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "zdr",
  "enforce_distillable_text",
  "order",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "max_price",
  "preferred_min_throughput",
  "preferred_max_latency",
]);
const VERCEL_ROUTING_KEYS = new Set(["only", "order"]);

interface CurrentSource {
  exists: boolean;
  revision: string;
  source: string;
  config?: ModelsConfig;
  diagnostics: ModelsConfigDiagnostic[];
  sourceState: ModelsConfigSnapshot["sourceState"];
  stats?: Stats;
}

interface ModelsConfigServiceOptions {
  log?(message: string): void;
  now?(): number;
  createId?(): string;
}

/** Owns all reads and atomic writes for one agent directory's models.json. */
export class ModelsConfigService {
  readonly path: string;
  readonly agentDir: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly log?: (message: string) => void;
  private readonly createId: () => string;

  constructor(agentDir: string, options: ModelsConfigServiceOptions = {}) {
    this.agentDir = agentDir;
    this.path = join(agentDir, "models.json");
    this.log = options.log;
    this.createId = options.createId ?? randomUUID;
  }

  async getConfig(): Promise<ModelsConfigSnapshot> {
    return snapshotFromCurrent(this.path, await this.readCurrent());
  }

  async getConfigRevision(): Promise<string> {
    return (await this.readCurrent()).revision;
  }

  async getExternalOpenTarget(): Promise<string> {
    return (await this.readCurrent()).exists ? this.path : this.agentDir;
  }

  saveConfig(input: SaveModelsConfigInput): Promise<SaveModelsConfigResult> {
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveModelsConfigInput): Promise<SaveModelsConfigResult> {
    assertSaveInputShape(input);
    const providers = omitUndefinedProperties(input.providers);
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
        this.writeLog("conflict", current, providers);
        return { status: "conflict", current: snapshotFromCurrent(this.path, current) };
      }
      if (current.sourceState === "invalid") {
        return { status: "invalid", diagnostics: current.diagnostics };
      }
      const baseConfig = current.config ?? { providers: {} };
      const projected = projectDraft(providers, baseConfig);
      if (!projected.ok) return { status: "invalid", diagnostics: projected.diagnostics };

      const validation = validateModelsConfigValue(projected.config, this.path);
      if (!validation.ok) {
        return { status: "invalid", diagnostics: validation.diagnostics.map(toDesktopDiagnostic) };
      }

      const initialSource = current.exists ? current.source : '{\n  "providers": {}\n}\n';
      const modelAligned = alignModelArrays(initialSource, projected.modelAlignments);
      const aligned = alignRenamedKeys(modelAligned.source, projected.renames);
      const candidate = applyValueDiff(aligned.source, aligned.config, projected.config);
      const reparsed = parseModelsConfigSource(candidate, this.path);
      if (!reparsed.ok) {
        throw new Error(
          `Generated models.json failed validation:\n${formatModelsConfigDiagnostics(reparsed.diagnostics)}`,
        );
      }
      if (!isDeepStrictEqual(reparsed.value, projected.config)) {
        throw new Error("Generated models.json does not match the validated configuration");
      }

      await this.atomicWrite(candidate);
      const saved = await this.readCurrent();
      this.writeLog("saved", saved, providers);
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
          revision: MISSING_MODELS_CONFIG_REVISION,
          source: "",
          diagnostics: [],
          sourceState: "missing",
        };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
    if (!stats.isFile()) throw new Error(`models.json is not a regular file: ${this.path}`);

    const bytes = await readFile(this.path);
    const source = bytes.toString("utf8");
    const revision = hashBytes(bytes);
    const parsed = parseModelsConfigSource(source, this.path);
    if (!parsed.ok) {
      return {
        exists: true,
        revision,
        source,
        diagnostics: parsed.diagnostics.map(toDesktopDiagnostic),
        sourceState: "invalid",
        stats,
      };
    }
    return {
      exists: true,
      revision,
      source,
      config: parsed.value,
      diagnostics: parsed.diagnostics.map(toDesktopDiagnostic),
      sourceState: "valid",
      stats,
    };
  }

  private async atomicWrite(source: string): Promise<void> {
    const tempPath = join(dirname(this.path), `.models.json.${process.pid}.${this.createId()}.tmp`);
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
      const directory = await open(this.agentDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private writeLog(result: string, current: CurrentSource, providers: ModelsProviderDraft[]): void {
    if (!this.log) return;
    const modelCount = providers.reduce((total, provider) => total + provider.models.length, 0);
    this.log(
      `models config ${result}: path=${this.path} revision=${current.revision.slice(0, 12)} providers=${providers.length} models=${modelCount}`,
    );
  }
}

interface DraftProjectionSuccess {
  ok: true;
  config: ModelsConfig;
  renames: KeyRename[];
  modelAlignments: ModelArrayAlignment[];
}

interface DraftProjectionFailure {
  ok: false;
  diagnostics: ModelsConfigDiagnostic[];
}

interface KeyRename {
  parentPath: ModelsConfigPath;
  from: string;
  to: string;
}

interface ModelArrayAlignment {
  path: ModelsConfigPath;
  currentLength: number;
  retainedIndices: number[];
  additions: ModelsModelDefinition[];
}

function projectDraft(
  providers: ModelsProviderDraft[],
  current: ModelsConfig,
): DraftProjectionSuccess | DraftProjectionFailure {
  const diagnostics: ModelsConfigDiagnostic[] = [];
  const renames: KeyRename[] = [];
  const modelAlignments: ModelArrayAlignment[] = [];
  const providerKeys = new Set<string>();
  const providerOrigins = new Set<string>();
  const nextProviders: Record<string, ModelsProviderConfig> = {};

  for (const provider of providers) {
    if (!provider.key || providerKeys.has(provider.key)) {
      diagnostics.push(inputDiagnostic(["providers", provider.key], "Provider keys must be non-empty and unique."));
      continue;
    }
    providerKeys.add(provider.key);
    const originKey = provider.origin?.providerKey;
    let currentProvider: ModelsProviderConfig | undefined;
    if (originKey !== undefined) {
      if (providerOrigins.has(originKey) || !Object.hasOwn(current.providers, originKey)) {
        diagnostics.push(inputDiagnostic(["providers", provider.key], "Provider origin is missing or duplicated."));
        continue;
      }
      providerOrigins.add(originKey);
      currentProvider = current.providers[originKey];
      if (originKey !== provider.key) renames.push({ parentPath: ["providers"], from: originKey, to: provider.key });
    }

    const projected = projectProvider(provider, currentProvider, originKey, diagnostics, renames, modelAlignments);
    if (projected) nextProviders[provider.key] = projected;
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const config = cloneRecord(current) as ModelsConfig;
  config.providers = nextProviders;
  return { ok: true, config, renames, modelAlignments };
}

function projectProvider(
  draft: ModelsProviderDraft,
  current: ModelsProviderConfig | undefined,
  originKey: string | undefined,
  diagnostics: ModelsConfigDiagnostic[],
  renames: KeyRename[],
  modelAlignments: ModelArrayAlignment[],
): ModelsProviderConfig | undefined {
  const provider = mergeKnown(current, draft.config, PROVIDER_ALL_KEYS);
  if (provider.apiKey === "") delete provider.apiKey;
  const providerPath = ["providers", draft.key] as const;
  provider.headers = projectMap(
    draft.headers,
    current?.headers,
    originKey === undefined ? undefined : ["providers", originKey, "headers"],
    [...providerPath, "headers"],
    diagnostics,
    renames,
  );
  if (!provider.headers || Object.keys(provider.headers).length === 0) delete provider.headers;
  provider.compat = projectCompat(
    draft.compat,
    current?.compat as ModelsCompat | undefined,
    originKey === undefined ? undefined : ["providers", originKey, "compat"],
    [...providerPath, "compat"],
    diagnostics,
    renames,
  );
  if (!provider.compat) delete provider.compat;

  provider.models = projectModels(
    draft.models,
    current?.models,
    originKey,
    providerPath,
    diagnostics,
    renames,
    modelAlignments,
  );
  if (provider.models.length === 0) delete provider.models;
  provider.modelOverrides = projectOverrides(
    draft.modelOverrides,
    current?.modelOverrides,
    originKey,
    providerPath,
    diagnostics,
    renames,
  );
  if (Object.keys(provider.modelOverrides).length === 0) delete provider.modelOverrides;
  return provider;
}

function projectModels(
  drafts: ModelsModelDraft[],
  current: ModelsModelDefinition[] | undefined,
  originProvider: string | undefined,
  providerPath: ModelsConfigPath,
  diagnostics: ModelsConfigDiagnostic[],
  renames: KeyRename[],
  modelAlignments: ModelArrayAlignment[],
): ModelsModelDefinition[] {
  const currentModels = current ?? [];
  const usedOrigins = new Set<number>();
  const additions: ModelsModelDefinition[] = [];
  let previousOrigin = -1;
  let sawNewModel = false;
  const projected = drafts.map((draft, index) => {
    let existing: ModelsModelDefinition | undefined;
    const origin = draft.origin;
    if (origin) {
      if (
        sawNewModel ||
        origin.providerKey !== originProvider ||
        !Number.isSafeInteger(origin.modelIndex) ||
        origin.modelIndex < 0 ||
        origin.modelIndex >= currentModels.length ||
        usedOrigins.has(origin.modelIndex) ||
        origin.modelIndex <= previousOrigin
      ) {
        diagnostics.push(inputDiagnostic([...providerPath, "models", index], "Model origin is invalid or reordered."));
      } else {
        usedOrigins.add(origin.modelIndex);
        previousOrigin = origin.modelIndex;
        existing = currentModels[origin.modelIndex];
      }
    } else {
      sawNewModel = true;
    }
    const model = mergeKnown(existing, draft.config, MODEL_ALL_KEYS);
    model.headers = projectMap(
      draft.headers,
      existing?.headers,
      origin ? ["providers", origin.providerKey, "models", origin.modelIndex, "headers"] : undefined,
      [...providerPath, "models", index, "headers"],
      diagnostics,
      renames,
    );
    if (!model.headers || Object.keys(model.headers).length === 0) delete model.headers;
    model.compat = projectCompat(
      draft.compat,
      existing?.compat as ModelsCompat | undefined,
      origin ? ["providers", origin.providerKey, "models", origin.modelIndex, "compat"] : undefined,
      [...providerPath, "models", index, "compat"],
      diagnostics,
      renames,
    );
    if (!model.compat) delete model.compat;
    if (!origin) additions.push(model);
    return model;
  });
  if (originProvider !== undefined && (current !== undefined || additions.length > 0)) {
    modelAlignments.push({
      path: ["providers", originProvider, "models"],
      currentLength: currentModels.length,
      retainedIndices: [...usedOrigins].sort((left, right) => left - right),
      additions,
    });
  }
  return projected;
}

function projectOverrides(
  drafts: ModelsModelOverrideDraft[],
  current: Record<string, ModelsModelOverride> | undefined,
  originProvider: string | undefined,
  providerPath: ModelsConfigPath,
  diagnostics: ModelsConfigDiagnostic[],
  renames: KeyRename[],
): Record<string, ModelsModelOverride> {
  const result: Record<string, ModelsModelOverride> = {};
  const keys = new Set<string>();
  const origins = new Set<string>();
  for (const draft of drafts) {
    if (!draft.modelId || keys.has(draft.modelId)) {
      diagnostics.push(
        inputDiagnostic([...providerPath, "modelOverrides", draft.modelId], "Override keys must be unique."),
      );
      continue;
    }
    keys.add(draft.modelId);
    const origin = draft.origin;
    let existing: ModelsModelOverride | undefined;
    if (origin) {
      if (
        origin.providerKey !== originProvider ||
        origins.has(origin.modelId) ||
        !current ||
        !Object.hasOwn(current, origin.modelId)
      ) {
        diagnostics.push(
          inputDiagnostic([...providerPath, "modelOverrides", draft.modelId], "Override origin is invalid."),
        );
      } else {
        origins.add(origin.modelId);
        existing = current[origin.modelId];
        if (origin.modelId !== draft.modelId) {
          renames.push({
            parentPath: ["providers", origin.providerKey, "modelOverrides"],
            from: origin.modelId,
            to: draft.modelId,
          });
        }
      }
    }
    const override = mergeKnown(existing, draft.config, OVERRIDE_ALL_KEYS);
    override.headers = projectMap(
      draft.headers,
      existing?.headers,
      origin ? ["providers", origin.providerKey, "modelOverrides", origin.modelId, "headers"] : undefined,
      [...providerPath, "modelOverrides", draft.modelId, "headers"],
      diagnostics,
      renames,
    );
    if (!override.headers || Object.keys(override.headers).length === 0) delete override.headers;
    override.compat = projectCompat(
      draft.compat,
      existing?.compat as ModelsCompat | undefined,
      origin ? ["providers", origin.providerKey, "modelOverrides", origin.modelId, "compat"] : undefined,
      [...providerPath, "modelOverrides", draft.modelId, "compat"],
      diagnostics,
      renames,
    );
    if (!override.compat) delete override.compat;
    result[draft.modelId] = override;
  }
  return result;
}

function projectCompat(
  draft: ModelsCompatDraft | undefined,
  current: ModelsCompat | undefined,
  originPath: ModelsConfigPath | undefined,
  nextPath: ModelsConfigPath,
  diagnostics: ModelsConfigDiagnostic[],
  renames: KeyRename[],
): ModelsCompat | undefined {
  if (!draft) return undefined;
  const compat = mergeKnown(current, draft.config, COMPAT_ALL_KEYS) as ModelsCompat;
  const currentKwargs = current?.chatTemplateKwargs;
  const kwargs = projectMap(
    draft.chatTemplateKwargs ?? [],
    currentKwargs,
    originPath ? [...originPath, "chatTemplateKwargs"] : undefined,
    [...nextPath, "chatTemplateKwargs"],
    diagnostics,
    renames,
  );
  if (kwargs && Object.keys(kwargs).length > 0) compat.chatTemplateKwargs = kwargs;
  else delete compat.chatTemplateKwargs;
  return compat;
}

function projectMap<T>(
  entries: ModelsMapEntryDraft<T>[],
  current: Record<string, T> | undefined,
  originParentPath: ModelsConfigPath | undefined,
  nextParentPath: ModelsConfigPath,
  diagnostics: ModelsConfigDiagnostic[],
  renames: KeyRename[],
): Record<string, T> | undefined {
  const result: Record<string, T> = {};
  const keys = new Set<string>();
  const originKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry.key || keys.has(entry.key)) {
      diagnostics.push(inputDiagnostic([...nextParentPath, entry.key], "Map keys must be non-empty and unique."));
      continue;
    }
    keys.add(entry.key);
    if (entry.origin) {
      if (
        !originParentPath ||
        !samePath(entry.origin.parentPath, originParentPath) ||
        originKeys.has(entry.origin.key) ||
        !current ||
        !Object.hasOwn(current, entry.origin.key)
      ) {
        diagnostics.push(inputDiagnostic([...nextParentPath, entry.key], "Map entry origin is invalid."));
      } else {
        originKeys.add(entry.origin.key);
        if (entry.origin.key !== entry.key) {
          renames.push({ parentPath: originParentPath, from: entry.origin.key, to: entry.key });
        }
      }
    }
    result[entry.key] = cloneValue(entry.value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function snapshotFromCurrent(path: string, current: CurrentSource): ModelsConfigSnapshot {
  return {
    path,
    exists: current.exists,
    revision: current.revision,
    sourceState: current.sourceState,
    providers: current.config ? configToDraft(current.config) : [],
    metadata: getModelsConfigMetadata(),
    diagnostics: current.diagnostics,
    preservedUnknownPaths: current.config ? collectUnknownPaths(current.config) : [],
    activeSessionsRefreshed: false,
  };
}

function configToDraft(config: ModelsConfig): ModelsProviderDraft[] {
  return Object.entries(config.providers).map(([providerKey, provider]) => ({
    key: providerKey,
    origin: { providerKey },
    config: pickKnown(provider, PROVIDER_KEYS),
    headers: mapToDraft(provider.headers, ["providers", providerKey, "headers"]),
    compat: compatToDraft(provider.compat as ModelsCompat | undefined, ["providers", providerKey, "compat"]),
    models: (provider.models ?? []).map((model, modelIndex) => ({
      origin: { providerKey, modelIndex },
      config: pickKnown(model, MODEL_KEYS),
      headers: mapToDraft(model.headers, ["providers", providerKey, "models", modelIndex, "headers"]),
      compat: compatToDraft(model.compat as ModelsCompat | undefined, [
        "providers",
        providerKey,
        "models",
        modelIndex,
        "compat",
      ]),
    })),
    modelOverrides: Object.entries(provider.modelOverrides ?? {}).map(([modelId, override]) => ({
      modelId,
      origin: { providerKey, modelId },
      config: pickKnown(override, OVERRIDE_KEYS),
      headers: mapToDraft(override.headers, ["providers", providerKey, "modelOverrides", modelId, "headers"]),
      compat: compatToDraft(override.compat as ModelsCompat | undefined, [
        "providers",
        providerKey,
        "modelOverrides",
        modelId,
        "compat",
      ]),
    })),
  }));
}

function compatToDraft(compat: ModelsCompat | undefined, path: ModelsConfigPath): ModelsCompatDraft | undefined {
  if (!compat) return undefined;
  return {
    config: pickKnown(compat, COMPAT_KEYS),
    chatTemplateKwargs: mapToDraft(compat.chatTemplateKwargs, [...path, "chatTemplateKwargs"]),
  };
}

function mapToDraft<T>(record: Record<string, T> | undefined, parentPath: ModelsConfigPath): ModelsMapEntryDraft<T>[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({
    key,
    value: cloneValue(value),
    origin: { parentPath, key },
  }));
}

function alignModelArrays(source: string, alignments: ModelArrayAlignment[]): { source: string; config: ModelsConfig } {
  let nextSource = source;
  const formatting = detectFormatting(source);
  for (const alignment of alignments) {
    if (alignment.currentLength === 0 && alignment.additions.length > 0) {
      nextSource = applyEdits(
        nextSource,
        modify(nextSource, [...alignment.path], alignment.additions, { formattingOptions: formatting }),
      );
      continue;
    }
    const retained = new Set(alignment.retainedIndices);
    for (let index = alignment.currentLength - 1; index >= 0; index -= 1) {
      if (!retained.has(index)) {
        nextSource = applyEdits(
          nextSource,
          modify(nextSource, [...alignment.path, index], undefined, { formattingOptions: formatting }),
        );
      }
    }
    for (let index = 0; index < alignment.additions.length; index += 1) {
      nextSource = applyEdits(
        nextSource,
        modify(nextSource, [...alignment.path, alignment.retainedIndices.length + index], alignment.additions[index], {
          formattingOptions: formatting,
        }),
      );
    }
  }
  const parsed = parseModelsConfigSource(nextSource);
  if (!parsed.ok) throw new Error("Aligning JSONC model arrays produced invalid source");
  return { source: nextSource, config: parsed.value };
}

function alignRenamedKeys(source: string, renames: KeyRename[]): { source: string; config: ModelsConfig } {
  let nextSource = source;
  const deepestFirst = [...renames].sort((left, right) => right.parentPath.length - left.parentPath.length);
  for (const renameOperation of deepestFirst) {
    nextSource = renameObjectKey(nextSource, renameOperation.parentPath, renameOperation.from, renameOperation.to);
  }
  const parsed = parseModelsConfigSource(nextSource);
  if (!parsed.ok) throw new Error("Renaming JSONC keys produced invalid source");
  return { source: nextSource, config: parsed.value };
}

function renameObjectKey(source: string, parentPath: ModelsConfigPath, from: string, to: string): string {
  const root = parseTree(source);
  const parent = root ? findNodeAtLocation(root, [...parentPath]) : undefined;
  const property = findPropertyNode(parent, from);
  const keyNode = property?.children?.[0];
  if (!keyNode) throw new Error(`Cannot find JSONC key to rename at ${[...parentPath, from].join("/")}`);
  return `${source.slice(0, keyNode.offset)}${JSON.stringify(to)}${source.slice(keyNode.offset + keyNode.length)}`;
}

function findPropertyNode(parent: Node | undefined, key: string): Node | undefined {
  if (parent?.type !== "object") return undefined;
  return parent.children?.find((child) => child.type === "property" && child.children?.[0]?.value === key);
}

function applyValueDiff(source: string, current: unknown, desired: unknown): string {
  let next = source;
  const formatting = detectFormatting(source);
  const apply = (path: Array<string | number>, before: unknown, after: unknown): void => {
    if (isDeepStrictEqual(before, after)) return;
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key))
          next = applyEdits(next, modify(next, [...path, key], undefined, { formattingOptions: formatting }));
      }
      for (const [key, value] of Object.entries(after)) {
        if (Object.hasOwn(before, key)) apply([...path, key], before[key], value);
        else next = applyEdits(next, modify(next, [...path, key], value, { formattingOptions: formatting }));
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const commonLength = Math.min(before.length, after.length);
      for (let index = 0; index < commonLength; index += 1) apply([...path, index], before[index], after[index]);
      for (let index = before.length - 1; index >= after.length; index -= 1) {
        next = applyEdits(next, modify(next, [...path, index], undefined, { formattingOptions: formatting }));
      }
      for (let index = commonLength; index < after.length; index += 1) {
        next = applyEdits(next, modify(next, [...path, index], after[index], { formattingOptions: formatting }));
      }
      return;
    }
    next = applyEdits(next, modify(next, path, after, { formattingOptions: formatting }));
  };
  apply([], current, desired);
  return next;
}

function collectUnknownPaths(config: ModelsConfig): ModelsConfigPath[] {
  const paths: ModelsConfigPath[] = [];
  collectUnknownObject(config as Record<string, unknown>, new Set(["providers"]), [], paths);
  for (const [providerKey, provider] of Object.entries(config.providers)) {
    const providerPath = ["providers", providerKey] as const;
    collectUnknownObject(provider as Record<string, unknown>, PROVIDER_ALL_KEYS, providerPath, paths);
    collectNestedUnknown(provider, providerPath, paths);
    for (let index = 0; index < (provider.models?.length ?? 0); index += 1) {
      const model = provider.models![index];
      const modelPath = [...providerPath, "models", index] as const;
      collectUnknownObject(model as Record<string, unknown>, MODEL_ALL_KEYS, modelPath, paths);
      collectNestedUnknown(model, modelPath, paths);
    }
    for (const [modelId, override] of Object.entries(provider.modelOverrides ?? {})) {
      const overridePath = [...providerPath, "modelOverrides", modelId] as const;
      collectUnknownObject(override as Record<string, unknown>, OVERRIDE_ALL_KEYS, overridePath, paths);
      collectNestedUnknown(override, overridePath, paths);
    }
  }
  return paths;
}

function collectNestedUnknown(
  value: { compat?: unknown; cost?: unknown; thinkingLevelMap?: unknown },
  path: ModelsConfigPath,
  paths: ModelsConfigPath[],
): void {
  if (isPlainObject(value.compat)) {
    collectUnknownObject(value.compat, COMPAT_ALL_KEYS, [...path, "compat"], paths);
    if (isPlainObject(value.compat.openRouterRouting)) {
      collectUnknownObject(
        value.compat.openRouterRouting,
        OPEN_ROUTER_KEYS,
        [...path, "compat", "openRouterRouting"],
        paths,
      );
    }
    if (isPlainObject(value.compat.vercelGatewayRouting)) {
      collectUnknownObject(
        value.compat.vercelGatewayRouting,
        VERCEL_ROUTING_KEYS,
        [...path, "compat", "vercelGatewayRouting"],
        paths,
      );
    }
  }
  if (isPlainObject(value.thinkingLevelMap)) {
    collectUnknownObject(value.thinkingLevelMap, THINKING_KEYS, [...path, "thinkingLevelMap"], paths);
  }
  if (isPlainObject(value.cost)) {
    collectUnknownObject(value.cost, COST_KEYS, [...path, "cost"], paths);
    if (Array.isArray(value.cost.tiers)) {
      value.cost.tiers.forEach((tier, index) => {
        if (isPlainObject(tier)) collectUnknownObject(tier, COST_TIER_KEYS, [...path, "cost", "tiers", index], paths);
      });
    }
  }
}

function collectUnknownObject(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: ModelsConfigPath,
  paths: ModelsConfigPath[],
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) paths.push([...path, key]);
  }
}

function mergeKnown<T extends object>(current: T | undefined, draft: Partial<T>, knownKeys: ReadonlySet<string>): T {
  const result = current ? cloneRecord(current) : ({} as T);
  const record = result as Record<string, unknown>;
  for (const key of knownKeys) delete record[key];
  Object.assign(record, cloneRecord(draft));
  return result;
}

function pickKnown<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = cloneValue(value[key]);
  }
  return result as Pick<T, K>;
}

function detectFormatting(source: string): FormattingOptions {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = source.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  return indent.includes("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: Math.max(1, indent.length), eol };
}

function assertSaveInputShape(input: SaveModelsConfigInput): void {
  if (!isPlainObject(input) || typeof input.expectedRevision !== "string" || !Array.isArray(input.providers)) {
    throw new TypeError("Invalid models save input");
  }
  if (input.confirmationToken !== undefined && typeof input.confirmationToken !== "string") {
    throw new TypeError("Invalid models confirmation token");
  }
  for (const provider of input.providers) {
    if (!isPlainObject(provider) || typeof provider.key !== "string" || !Array.isArray(provider.models)) {
      throw new TypeError("Invalid provider draft");
    }
    if (
      !Array.isArray(provider.headers) ||
      !Array.isArray(provider.modelOverrides) ||
      !isPlainObject(provider.config)
    ) {
      throw new TypeError("Invalid provider draft fields");
    }
    assertOrigin(provider.origin, "provider");
    assertMapEntries(provider.headers);
    assertCompatDraft(provider.compat);
    for (const model of provider.models) {
      if (!isPlainObject(model) || !isPlainObject(model.config) || !Array.isArray(model.headers)) {
        throw new TypeError("Invalid model draft");
      }
      assertOrigin(model.origin, "model");
      assertMapEntries(model.headers);
      assertCompatDraft(model.compat);
    }
    for (const override of provider.modelOverrides) {
      if (
        !isPlainObject(override) ||
        typeof override.modelId !== "string" ||
        !isPlainObject(override.config) ||
        !Array.isArray(override.headers)
      ) {
        throw new TypeError("Invalid model override draft");
      }
      assertOrigin(override.origin, "override");
      assertMapEntries(override.headers);
      assertCompatDraft(override.compat);
    }
  }
}

function assertMapEntries(entries: unknown[]): void {
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.key !== "string" || !("value" in entry)) {
      throw new TypeError("Invalid map entry draft");
    }
    assertOrigin(entry.origin, "map");
  }
}

function assertCompatDraft(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value) || !isPlainObject(value.config)) throw new TypeError("Invalid compat draft");
  if (value.chatTemplateKwargs !== undefined) {
    if (!Array.isArray(value.chatTemplateKwargs)) throw new TypeError("Invalid chatTemplateKwargs draft");
    assertMapEntries(value.chatTemplateKwargs);
  }
}

function assertOrigin(value: unknown, kind: "provider" | "model" | "override" | "map"): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new TypeError(`Invalid ${kind} origin`);
  if (kind === "provider" && typeof value.providerKey !== "string") throw new TypeError("Invalid provider origin");
  if (kind === "model" && (typeof value.providerKey !== "string" || !Number.isSafeInteger(value.modelIndex))) {
    throw new TypeError("Invalid model origin");
  }
  if (kind === "override" && (typeof value.providerKey !== "string" || typeof value.modelId !== "string")) {
    throw new TypeError("Invalid override origin");
  }
  if (
    kind === "map" &&
    (!Array.isArray(value.parentPath) ||
      value.parentPath.some((segment) => typeof segment !== "string" && !Number.isSafeInteger(segment)) ||
      typeof value.key !== "string")
  ) {
    throw new TypeError("Invalid map origin");
  }
}

function toDesktopDiagnostic(diagnostic: PiModelsConfigDiagnostic): ModelsConfigDiagnostic {
  return { ...diagnostic, path: [...diagnostic.path] };
}

function inputDiagnostic(path: ModelsConfigPath, message: string): ModelsConfigDiagnostic {
  return { severity: "error", code: "input.invalid", path, message };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneRecord<T extends object>(value: T): T {
  return structuredClone(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function omitUndefinedProperties<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => omitUndefinedProperties(item)) as T;
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = omitUndefinedProperties(child);
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function samePath(left: ModelsConfigPath, right: ModelsConfigPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
