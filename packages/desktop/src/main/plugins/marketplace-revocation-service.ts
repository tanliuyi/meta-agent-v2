import { createPublicKey, randomUUID, verify } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  InstalledMarketplacePluginSummary,
  InstalledMarketplacePluginsSnapshot,
  MarketplacePluginRevocation,
  MarketplaceRevocationCheck,
} from "../../shared/plugin-marketplace-contracts.ts";
import type {
  MarketplaceEndpointSettingsService,
  TrustedMarketplaceEndpoint,
} from "./marketplace-endpoint-settings-service.ts";
import { readBoundedJsonResponse } from "./marketplace-http.ts";

interface RevokedKey {
  keyId: string;
  reasonCode: string;
}

interface PluginVersionRevocation extends MarketplacePluginRevocation {
  pluginId: string;
  version: string;
  artifactIds?: string[];
}

interface RevocationData {
  marketplaceId: string;
  sequence: number;
  issuedAt: number;
  nextUpdateAt: number;
  revokedKeys: RevokedKey[];
  pluginVersions: PluginVersionRevocation[];
}

interface SignedRevocationEnvelope {
  data: RevocationData;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}

interface RevocationCacheFile extends SignedRevocationEnvelope {
  version: 1;
  checkedAt: number;
}

interface MarketplaceRevocationServiceOptions {
  fetch?: typeof fetch;
  now?(): number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  createId?(): string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export class MarketplaceRevocationService {
  private readonly endpoints: MarketplaceEndpointSettingsService;
  private readonly directory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly createId: () => string;
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(
    endpoints: MarketplaceEndpointSettingsService,
    userDataDir: string,
    options: MarketplaceRevocationServiceOptions = {},
  ) {
    this.endpoints = endpoints;
    this.directory = join(userDataDir, "plugins", "revocations");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.createId = options.createId ?? randomUUID;
  }

  refresh(marketplaceId: string): Promise<RevocationData> {
    const operation = this.refreshTail.then(() => this.refreshSerialized(marketplaceId));
    this.refreshTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async assertArtifactAllowed(
    marketplaceId: string,
    pluginId: string,
    version: string,
    artifactId: string,
  ): Promise<void> {
    const endpoint = await this.endpoints.getTrustedEndpoint(marketplaceId);
    const data = await this.refresh(marketplaceId);
    if (data.nextUpdateAt <= this.now()) throw new Error("Marketplace revocation snapshot is already stale");
    if (data.revokedKeys.some((entry) => entry.keyId === endpoint.signing.keyId)) {
      throw new Error("Marketplace signing key is revoked");
    }
    const revocation = findPluginRevocation(data, pluginId, version, artifactId);
    if (revocation) {
      throw new Error(`Marketplace plugin version is ${revocation.status}: ${revocation.message}`);
    }
  }

  async getCachedPluginRevocation(
    plugin: Pick<InstalledMarketplacePluginSummary, "id" | "marketplaceId" | "version" | "artifactId">,
  ): Promise<MarketplacePluginRevocation | undefined> {
    const endpoint = await this.endpoints.getTrustedEndpoint(plugin.marketplaceId);
    const cache = await this.readCache(endpoint);
    if (!cache) return undefined;
    if (cache.data.revokedKeys.some((entry) => entry.keyId === endpoint.signing.keyId)) {
      return {
        status: "blocked",
        reasonCode: "SIGNING_KEY_REVOKED",
        message: "The signing key for this marketplace has been revoked.",
        checkedAt: cache.checkedAt,
        stale: cache.data.nextUpdateAt <= this.now(),
      };
    }
    const revocation = findPluginRevocation(cache.data, plugin.id, plugin.version, plugin.artifactId);
    if (!revocation) return undefined;
    return {
      status: revocation.status,
      reasonCode: revocation.reasonCode,
      message: revocation.message,
      ...(revocation.replacementVersion ? { replacementVersion: revocation.replacementVersion } : {}),
      checkedAt: cache.checkedAt,
      stale: cache.data.nextUpdateAt <= this.now(),
    };
  }

  async decorateSnapshot(snapshot: InstalledMarketplacePluginsSnapshot): Promise<InstalledMarketplacePluginsSnapshot> {
    const marketplaceIds = [...new Set(snapshot.plugins.map((plugin) => plugin.marketplaceId))];
    return {
      revision: snapshot.revision,
      revocationChecks: await Promise.all(marketplaceIds.map((marketplaceId) => this.getCacheCheck(marketplaceId))),
      plugins: await Promise.all(
        snapshot.plugins.map(async (plugin) => {
          let revocation: MarketplacePluginRevocation | undefined;
          try {
            revocation = await this.getCachedPluginRevocation(plugin);
          } catch {
            revocation = undefined;
          }
          return cloneSummary(plugin, revocation);
        }),
      ),
    };
  }

  private async getCacheCheck(marketplaceId: string): Promise<MarketplaceRevocationCheck> {
    try {
      const endpoint = await this.endpoints.getTrustedEndpoint(marketplaceId);
      const cache = await this.readCache(endpoint);
      if (!cache) return { marketplaceId, status: "missing" };
      return {
        marketplaceId,
        status: cache.data.nextUpdateAt <= this.now() ? "stale" : "fresh",
        checkedAt: cache.checkedAt,
      };
    } catch {
      return { marketplaceId, status: "missing" };
    }
  }

  private async refreshSerialized(marketplaceId: string): Promise<RevocationData> {
    const endpoint = await this.endpoints.getTrustedEndpoint(marketplaceId);
    const url = new URL("revocations", endpoint.apiRoot);
    const root = new URL(endpoint.apiRoot);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      throw new Error("Marketplace revocation URL escapes the trusted API root");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let value: unknown;
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Marketplace revocation request failed with HTTP ${response.status}`);
      value = await readBoundedJsonResponse(response, this.maxResponseBytes, "Marketplace revocation response");
    } finally {
      clearTimeout(timer);
    }
    const envelope = parseEnvelope(value);
    verifyEnvelope(envelope, endpoint, this.now());
    const previous = await this.readCache(endpoint);
    assertMonotonicSnapshot(envelope.data, previous?.data);
    const cache: RevocationCacheFile = { version: 1, checkedAt: this.now(), ...envelope };
    await this.writeCache(cache, endpoint);
    return cloneData(cache.data);
  }

  private async readCache(endpoint: TrustedMarketplaceEndpoint): Promise<RevocationCacheFile | undefined> {
    const path = this.pathFor(endpoint.marketplaceId);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Marketplace revocation cache is unsafe");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("Marketplace revocation cache JSON is invalid");
    }
    if (!isObject(value) || value.version !== 1 || typeof value.checkedAt !== "number") {
      throw new Error("Marketplace revocation cache is invalid");
    }
    const envelope = parseEnvelope(value);
    verifyEnvelope(envelope, endpoint, value.checkedAt);
    return { version: 1, checkedAt: value.checkedAt, ...envelope };
  }

  private async writeCache(cache: RevocationCacheFile, endpoint: TrustedMarketplaceEndpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(cache.data.marketplaceId);
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 750, randomize: true },
    });
    const temp = join(this.directory, `.${cache.data.marketplaceId}.${process.pid}.${this.createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const current = await this.readCache(endpoint);
      assertMonotonicSnapshot(cache.data, current?.data);
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, path);
      await chmod(path, 0o600);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      await release();
    }
  }

  private pathFor(marketplaceId: string): string {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(marketplaceId)) throw new Error("Marketplace ID is invalid");
    return join(this.directory, `${marketplaceId}.json`);
  }
}

function parseEnvelope(value: unknown): SignedRevocationEnvelope {
  if (!isObject(value) || !isObject(value.data) || !isObject(value.signature)) {
    throw new Error("Marketplace revocation envelope is invalid");
  }
  const data = value.data;
  const signature = value.signature;
  if (
    typeof data.marketplaceId !== "string" ||
    !Number.isSafeInteger(data.sequence) ||
    (data.sequence as number) < 0 ||
    typeof data.issuedAt !== "number" ||
    typeof data.nextUpdateAt !== "number" ||
    !Array.isArray(data.revokedKeys) ||
    !data.revokedKeys.every(isRevokedKey) ||
    !Array.isArray(data.pluginVersions) ||
    !data.pluginVersions.every(isPluginRevocation) ||
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.value !== "string"
  ) {
    throw new Error("Marketplace revocation envelope is invalid");
  }
  return value as unknown as SignedRevocationEnvelope;
}

function verifyEnvelope(envelope: SignedRevocationEnvelope, endpoint: TrustedMarketplaceEndpoint, now: number): void {
  if (envelope.data.marketplaceId !== endpoint.marketplaceId) {
    throw new Error("Marketplace revocation identity does not match the endpoint");
  }
  if (envelope.signature.keyId !== endpoint.signing.keyId) {
    throw new Error("Marketplace revocation signing key changed");
  }
  if (envelope.data.issuedAt > now + MAX_CLOCK_SKEW_MS || envelope.data.nextUpdateAt <= envelope.data.issuedAt) {
    throw new Error("Marketplace revocation time range is invalid");
  }
  const signature = decodeBase64(envelope.signature.value);
  const publicKey = createPublicKey({
    key: Buffer.from(endpoint.signing.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(envelope.data), "utf8"), publicKey, signature)) {
    throw new Error("Marketplace revocation signature is invalid");
  }
}

function assertMonotonicSnapshot(candidate: RevocationData, previous: RevocationData | undefined): void {
  if (!previous) return;
  if (candidate.sequence < previous.sequence) {
    throw new Error("Marketplace revocation sequence rollback detected");
  }
  if (candidate.sequence === previous.sequence && canonicalJson(candidate) !== canonicalJson(previous)) {
    throw new Error("Marketplace revocation sequence equivocation detected");
  }
}

function findPluginRevocation(
  data: RevocationData,
  pluginId: string,
  version: string,
  artifactId: string,
): PluginVersionRevocation | undefined {
  return data.pluginVersions.find(
    (entry) =>
      entry.pluginId === pluginId &&
      entry.version === version &&
      (entry.artifactIds === undefined || entry.artifactIds.includes(artifactId)),
  );
}

function isRevokedKey(value: unknown): value is RevokedKey {
  return isObject(value) && typeof value.keyId === "string" && typeof value.reasonCode === "string";
}

function isPluginRevocation(value: unknown): value is PluginVersionRevocation {
  return (
    isObject(value) &&
    typeof value.pluginId === "string" &&
    typeof value.version === "string" &&
    (value.artifactIds === undefined ||
      (Array.isArray(value.artifactIds) && value.artifactIds.every((entry) => typeof entry === "string"))) &&
    (value.status === "withdrawn" || value.status === "blocked") &&
    typeof value.reasonCode === "string" &&
    typeof value.message === "string" &&
    (value.replacementVersion === undefined || typeof value.replacementVersion === "string")
  );
}

function cloneData(data: RevocationData): RevocationData {
  return {
    ...data,
    revokedKeys: data.revokedKeys.map((entry) => ({ ...entry })),
    pluginVersions: data.pluginVersions.map((entry) => ({
      ...entry,
      ...(entry.artifactIds ? { artifactIds: [...entry.artifactIds] } : {}),
    })),
  };
}

function cloneSummary(
  plugin: InstalledMarketplacePluginSummary,
  revocation: MarketplacePluginRevocation | undefined,
): InstalledMarketplacePluginSummary {
  return {
    ...plugin,
    capabilities: [...plugin.capabilities],
    ...(revocation ? { revocation: { ...revocation } } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical JSON contains an unsupported value");
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value)
    throw new Error("Marketplace revocation signature encoding is invalid");
  return decoded;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
