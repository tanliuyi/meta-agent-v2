import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  MarketplaceEndpointRecord,
  MarketplaceEndpointSettingsSnapshot,
  SaveMarketplaceEndpointInput,
  SaveMarketplaceEndpointResult,
  TestMarketplaceEndpointInput,
  TestMarketplaceEndpointResult,
} from "../../shared/plugin-marketplace-contracts.ts";
import { MARKETPLACE_PROTOCOL_VERSION } from "../../shared/plugin-marketplace-contracts.ts";
import { readBoundedJsonResponse } from "./marketplace-http.ts";

export const MISSING_MARKETPLACE_ENDPOINT_REVISION = "missing:marketplace-endpoints-v1";

export interface TrustedMarketplaceEndpoint extends Omit<MarketplaceEndpointRecord, "signing"> {
  signing: MarketplaceEndpointRecord["signing"] & { publicKey: string };
}

type StoredMarketplaceEndpointRecord = TrustedMarketplaceEndpoint;

interface MarketplaceEndpointFileData {
  version?: number;
  activeMarketplaceId?: string;
  endpoints?: StoredMarketplaceEndpointRecord[];
  [key: string]: unknown;
}

interface CurrentEndpointSource {
  revision: string;
  data: MarketplaceEndpointFileData;
  /** Set when the compiled-in default endpoint was injected in memory rather than loaded from disk. */
  injectedMarketplaceId?: string;
}

interface MarketplaceSignedEnvelope {
  data: unknown;
  signature: {
    algorithm: string;
    keyId: string;
    value: string;
  };
}

interface MarketplaceWellKnown {
  protocolVersion: number;
  marketplaceId: string;
  apiRoot: string;
  artifactOrigins: string[];
  signing: {
    algorithm: string;
    keyId: string;
    publicKey: string;
    fingerprint?: string;
  };
}

interface ConfirmationRecord {
  expectedRevision: string;
  endpoint: StoredMarketplaceEndpointRecord;
  expiresAt: number;
}

interface MarketplaceEndpointSettingsServiceOptions {
  createId?(): string;
  now?(): number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  defaultEndpoint?: TrustedMarketplaceEndpoint;
}

const CONFIRMATION_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

/** Owns marketplace endpoint trust bootstrap and file-backed settings. */
export class MarketplaceEndpointSettingsService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly defaultEndpoint?: TrustedMarketplaceEndpoint;
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly requestResults = new Map<string, SaveMarketplaceEndpointResult>();

  constructor(userDataDir: string, options: MarketplaceEndpointSettingsServiceOptions = {}) {
    this.path = join(userDataDir, "plugins", "marketplace-endpoints.json");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (options.defaultEndpoint) {
      assertEndpointRecord(options.defaultEndpoint);
      assertTrustedEndpointKey(options.defaultEndpoint);
      assertTrustedEndpointUrls(options.defaultEndpoint);
      if (!options.defaultEndpoint.active) throw new Error("Default marketplace endpoint must be active");
      this.defaultEndpoint = cloneEndpoint(options.defaultEndpoint);
    }
  }

  async getSettings(): Promise<MarketplaceEndpointSettingsSnapshot> {
    return snapshotFromCurrent(await this.readCurrent());
  }

  async getTrustedEndpoint(marketplaceId: string): Promise<TrustedMarketplaceEndpoint> {
    const current = await this.readCurrent();
    const endpoint = current.data.endpoints?.find((entry) => entry.marketplaceId === marketplaceId);
    if (!endpoint) throw new Error(`Marketplace trust record is unavailable: ${marketplaceId}`);
    return {
      ...endpoint,
      artifactOrigins: [...endpoint.artifactOrigins],
      signing: { ...endpoint.signing },
    };
  }

  async getActiveTrustedEndpoint(): Promise<TrustedMarketplaceEndpoint> {
    const current = await this.readCurrent();
    const active = current.data.endpoints?.find(
      (endpoint) => endpoint.marketplaceId === current.data.activeMarketplaceId && endpoint.active,
    );
    if (!active) throw new Error("Marketplace API URL is not configured");
    return {
      ...active,
      artifactOrigins: [...active.artifactOrigins],
      signing: { ...active.signing },
    };
  }

  async testEndpoint(input: TestMarketplaceEndpointInput): Promise<TestMarketplaceEndpointResult> {
    assertTestInput(input);
    try {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const endpoint = await this.discover(baseUrl);
      const current = await this.readCurrent();
      const trusted = current.data.endpoints?.find((entry) => sameEndpointIdentity(entry, endpoint));
      if (trusted) return { status: "ready", endpoint: endpointSnapshot(endpoint), confirmationRequired: false };
      const confirmationToken = this.createId();
      this.confirmations.set(confirmationToken, {
        expectedRevision: current.revision,
        endpoint,
        expiresAt: this.now() + CONFIRMATION_TTL_MS,
      });
      return {
        status: "ready",
        endpoint: endpointSnapshot(endpoint),
        confirmationRequired: true,
        confirmationToken,
      };
    } catch (error) {
      return {
        status: "invalid",
        code: endpointErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  saveEndpoint(input: SaveMarketplaceEndpointInput): Promise<SaveMarketplaceEndpointResult> {
    const cached = this.requestResults.get(input.requestId);
    if (cached) return Promise.resolve(cached);
    const operation = this.saveTail.then(() => this.saveEndpointLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveEndpointLocked(input: SaveMarketplaceEndpointInput): Promise<SaveMarketplaceEndpointResult> {
    assertSaveInput(input);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
    });
    try {
      const cached = this.requestResults.get(input.requestId);
      if (cached) return cached;
      const current = await this.readCurrent();
      if (current.revision !== input.expectedRevision) {
        const result: SaveMarketplaceEndpointResult = {
          status: "conflict",
          current: snapshotFromCurrent(current),
        };
        this.requestResults.set(input.requestId, result);
        return result;
      }
      const endpoint = await this.discover(baseUrl);
      const existing = current.data.endpoints?.find((entry) => sameEndpointIdentity(entry, endpoint));
      if (!existing) {
        const confirmation = input.confirmationToken ? this.confirmations.get(input.confirmationToken) : undefined;
        if (
          !confirmation ||
          confirmation.expiresAt < this.now() ||
          confirmation.expectedRevision !== current.revision ||
          !sameEndpointIdentity(confirmation.endpoint, endpoint)
        ) {
          const testResult = await this.testEndpoint({ baseUrl });
          if (testResult.status !== "ready") throw new Error(testResult.message);
          const result: SaveMarketplaceEndpointResult = { status: "confirmation-required", testResult };
          this.requestResults.set(input.requestId, result);
          return result;
        }
        this.confirmations.delete(input.confirmationToken!);
      }
      const endpoints = (current.data.endpoints ?? [])
        .filter(
          (entry) =>
            entry.marketplaceId !== endpoint.marketplaceId && entry.marketplaceId !== current.injectedMarketplaceId,
        )
        .map((entry) => ({ ...entry, active: false }));
      endpoints.push({ ...endpoint, active: true });
      await this.atomicWrite({
        ...current.data,
        version: 1,
        activeMarketplaceId: endpoint.marketplaceId,
        endpoints,
      });
      const result: SaveMarketplaceEndpointResult = {
        status: "saved",
        snapshot: snapshotFromCurrent(await this.readCurrent()),
      };
      this.requestResults.set(input.requestId, result);
      return result;
    } finally {
      await release();
    }
  }

  private async discover(baseUrl: string): Promise<StoredMarketplaceEndpointRecord> {
    const wellKnownUrl = new URL(".well-known/meta-agent-marketplace.json", baseUrl);
    const value = await this.fetchJson(wellKnownUrl, this.maxResponseBytes);
    const envelope = parseSignedEnvelope(value);
    const document = parseWellKnown(envelope.data);
    const publicKeyBytes = decodeBase64(document.signing.publicKey);
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    } catch {
      throw new Error("Marketplace signing public key is not valid Ed25519 SPKI");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Marketplace signing public key must use Ed25519");
    }
    const canonicalPublicKey = publicKey.export({ type: "spki", format: "der" });
    const fingerprint = `sha256:${createHash("sha256").update(canonicalPublicKey).digest("hex")}`;
    if (document.signing.fingerprint !== undefined && document.signing.fingerprint !== fingerprint) {
      throw new Error("Marketplace signing key fingerprint does not match its public key");
    }
    if (
      envelope.signature.algorithm !== "ed25519" ||
      envelope.signature.keyId !== document.signing.keyId ||
      !verify(null, Buffer.from(canonicalJson(document), "utf8"), publicKey, decodeBase64(envelope.signature.value))
    ) {
      throw new Error("Marketplace well-known signature is invalid");
    }
    const apiRoot = normalizeDiscoveredUrl(document.apiRoot, baseUrl, false);
    const artifactOrigins = document.artifactOrigins.map((origin) => normalizeDiscoveredUrl(origin, baseUrl, true));
    return {
      marketplaceId: document.marketplaceId,
      baseUrl,
      apiRoot,
      artifactOrigins,
      signing: {
        algorithm: "ed25519",
        keyId: document.signing.keyId,
        publicKey: document.signing.publicKey,
        fingerprint,
      },
      active: true,
    };
  }

  private async fetchJson(url: URL, maxBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Marketplace request failed with HTTP ${response.status}`);
      return await readBoundedJsonResponse(response, maxBytes, "Marketplace response");
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCurrent(): Promise<CurrentEndpointSource> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${this.path}`);
      if (!info.isFile()) throw new Error(`marketplace-endpoints.json is not a regular file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {
          revision: MISSING_MARKETPLACE_ENDPOINT_REVISION,
          ...withDefaultEndpoint({}, this.defaultEndpoint),
        };
      }
      throw error;
    }
    const bytes = await readFile(this.path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("marketplace-endpoints.json JSON syntax invalid");
    }
    assertEndpointFile(value);
    return { revision: hashBytes(bytes), ...withDefaultEndpoint(value, this.defaultEndpoint) };
  }

  private async atomicWrite(data: MarketplaceEndpointFileData): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.marketplace-endpoints.${process.pid}.${this.createId()}.tmp`);
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

function withDefaultEndpoint(
  data: MarketplaceEndpointFileData,
  defaultEndpoint: TrustedMarketplaceEndpoint | undefined,
): { data: MarketplaceEndpointFileData; injectedMarketplaceId?: string } {
  if (!defaultEndpoint) return { data };
  const active = data.endpoints?.find(
    (endpoint) => endpoint.active && endpoint.marketplaceId === data.activeMarketplaceId,
  );
  if (active) {
    if (data.endpoints?.some((endpoint) => endpoint.marketplaceId === defaultEndpoint.marketplaceId)) return { data };
    return {
      data: { ...data, endpoints: [...(data.endpoints ?? []), { ...cloneEndpoint(defaultEndpoint), active: false }] },
      injectedMarketplaceId: defaultEndpoint.marketplaceId,
    };
  }
  const endpoints = (data.endpoints ?? [])
    .filter((endpoint) => endpoint.marketplaceId !== defaultEndpoint.marketplaceId)
    .map((endpoint) => ({ ...cloneEndpoint(endpoint), active: false }));
  endpoints.push(cloneEndpoint(defaultEndpoint));
  return {
    data: {
      ...data,
      version: data.version ?? 1,
      activeMarketplaceId: defaultEndpoint.marketplaceId,
      endpoints,
    },
    injectedMarketplaceId: defaultEndpoint.marketplaceId,
  };
}

function cloneEndpoint(endpoint: TrustedMarketplaceEndpoint): TrustedMarketplaceEndpoint {
  return {
    ...endpoint,
    artifactOrigins: [...endpoint.artifactOrigins],
    signing: { ...endpoint.signing },
  };
}

function normalizeBaseUrl(input: string): string {
  const source = input.trim();
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Marketplace API URL is invalid");
  }
  if (url.username || url.password) throw new Error("Marketplace API URL must not contain credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Marketplace API URL must use HTTP or HTTPS");
  }
  if (url.search || url.hash) throw new Error("Marketplace API URL must not contain a query or fragment");
  assertSafeUrlPath(source, url.pathname, "Marketplace API URL");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

function normalizeDiscoveredUrl(value: string, baseUrl: string, originOnly: boolean): string {
  const url = new URL(value, baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Marketplace metadata contains an unsafe URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Marketplace metadata URL must use HTTP or HTTPS");
  }
  assertSafeUrlPath(value, url.pathname, "Marketplace metadata URL");
  if (originOnly && url.pathname !== "/") throw new Error("Marketplace artifact origin must not contain a path");
  if (!originOnly && !url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return originOnly ? url.origin : url.href;
}

function assertTrustedEndpointKey(endpoint: TrustedMarketplaceEndpoint): void {
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: decodeBase64(endpoint.signing.publicKey), format: "der", type: "spki" });
  } catch {
    throw new Error("Default marketplace signing public key is not valid Ed25519 SPKI");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Default marketplace signing public key must use Ed25519");
  }
  const bytes = publicKey.export({ type: "spki", format: "der" });
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (endpoint.signing.fingerprint !== `sha256:${hash}` || endpoint.signing.keyId !== `ed25519:${hash.slice(0, 16)}`) {
    throw new Error("Default marketplace signing identity does not match its public key");
  }
}

function assertTrustedEndpointUrls(endpoint: TrustedMarketplaceEndpoint): void {
  if (normalizeBaseUrl(endpoint.baseUrl) !== endpoint.baseUrl) {
    throw new Error("Default marketplace base URL is not normalized");
  }
  if (normalizeDiscoveredUrl(endpoint.apiRoot, endpoint.baseUrl, false) !== endpoint.apiRoot) {
    throw new Error("Default marketplace API root is not normalized");
  }
  for (const origin of endpoint.artifactOrigins) {
    if (normalizeDiscoveredUrl(origin, endpoint.baseUrl, true) !== origin) {
      throw new Error("Default marketplace artifact origin is not normalized");
    }
  }
}

function snapshotFromCurrent(current: CurrentEndpointSource): MarketplaceEndpointSettingsSnapshot {
  return {
    revision: current.revision,
    ...(current.data.activeMarketplaceId ? { activeMarketplaceId: current.data.activeMarketplaceId } : {}),
    endpoints: (current.data.endpoints ?? []).map(endpointSnapshot),
  };
}

function parseSignedEnvelope(value: unknown): MarketplaceSignedEnvelope {
  if (
    !isPlainObject(value) ||
    !("data" in value) ||
    !isPlainObject(value.signature) ||
    typeof value.signature.algorithm !== "string" ||
    typeof value.signature.keyId !== "string" ||
    typeof value.signature.value !== "string"
  ) {
    throw new Error("Marketplace well-known signature envelope is invalid");
  }
  return {
    data: value.data,
    signature: {
      algorithm: value.signature.algorithm,
      keyId: value.signature.keyId,
      value: value.signature.value,
    },
  };
}

function parseWellKnown(value: unknown): MarketplaceWellKnown {
  if (!isPlainObject(value)) throw new Error("Marketplace well-known document must be an object");
  if (value.protocolVersion !== MARKETPLACE_PROTOCOL_VERSION) {
    throw new Error("Marketplace protocol version is unsupported");
  }
  if (
    typeof value.marketplaceId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value.marketplaceId) ||
    typeof value.apiRoot !== "string" ||
    !Array.isArray(value.artifactOrigins) ||
    !value.artifactOrigins.every((entry) => typeof entry === "string") ||
    !isPlainObject(value.signing) ||
    value.signing.algorithm !== "ed25519" ||
    typeof value.signing.keyId !== "string" ||
    typeof value.signing.publicKey !== "string" ||
    (value.signing.fingerprint !== undefined && typeof value.signing.fingerprint !== "string")
  ) {
    throw new Error("Marketplace well-known document is invalid");
  }
  return value as unknown as MarketplaceWellKnown;
}

function assertEndpointFile(value: unknown): asserts value is MarketplaceEndpointFileData {
  if (!isPlainObject(value)) throw new Error("marketplace-endpoints.json must be an object");
  if (value.version !== undefined && value.version !== 1) {
    throw new Error("marketplace-endpoints.json version is unsupported");
  }
  if (value.activeMarketplaceId !== undefined && typeof value.activeMarketplaceId !== "string") {
    throw new Error("marketplace-endpoints.json activeMarketplaceId must be a string");
  }
  if (value.endpoints !== undefined) {
    if (!Array.isArray(value.endpoints)) throw new Error("marketplace-endpoints.json endpoints must be an array");
    for (const endpoint of value.endpoints) assertEndpointRecord(endpoint);
  }
}

function assertEndpointRecord(value: unknown): asserts value is StoredMarketplaceEndpointRecord {
  if (
    !isPlainObject(value) ||
    typeof value.marketplaceId !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.apiRoot !== "string" ||
    !Array.isArray(value.artifactOrigins) ||
    !value.artifactOrigins.every((entry) => typeof entry === "string") ||
    !isPlainObject(value.signing) ||
    value.signing.algorithm !== "ed25519" ||
    typeof value.signing.keyId !== "string" ||
    typeof value.signing.publicKey !== "string" ||
    typeof value.signing.fingerprint !== "string" ||
    typeof value.active !== "boolean"
  ) {
    throw new Error("marketplace-endpoints.json endpoint is invalid");
  }
}

function assertTestInput(input: TestMarketplaceEndpointInput): void {
  if (!input || typeof input !== "object" || typeof input.baseUrl !== "string") {
    throw new TypeError("Invalid marketplace endpoint test input");
  }
}

function assertSaveInput(input: SaveMarketplaceEndpointInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.requestId !== "string" ||
    typeof input.expectedRevision !== "string" ||
    typeof input.baseUrl !== "string" ||
    (input.confirmationToken !== undefined && typeof input.confirmationToken !== "string")
  ) {
    throw new TypeError("Invalid marketplace endpoint save input");
  }
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Marketplace signing public key is not valid base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw new Error("Marketplace signing public key is empty");
  return bytes;
}

function endpointSnapshot(endpoint: StoredMarketplaceEndpointRecord): MarketplaceEndpointRecord {
  return {
    ...endpoint,
    artifactOrigins: [...endpoint.artifactOrigins],
    signing: {
      algorithm: endpoint.signing.algorithm,
      keyId: endpoint.signing.keyId,
      fingerprint: endpoint.signing.fingerprint,
    },
  };
}

function sameEndpointIdentity(left: StoredMarketplaceEndpointRecord, right: StoredMarketplaceEndpointRecord): boolean {
  return (
    left.marketplaceId === right.marketplaceId &&
    left.baseUrl === right.baseUrl &&
    left.apiRoot === right.apiRoot &&
    left.artifactOrigins.length === right.artifactOrigins.length &&
    left.artifactOrigins.every((origin, index) => origin === right.artifactOrigins[index]) &&
    left.signing.keyId === right.signing.keyId &&
    left.signing.publicKey === right.signing.publicKey &&
    left.signing.fingerprint === right.signing.fingerprint
  );
}

function endpointErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "MARKETPLACE_UNAVAILABLE";
  if (error.message.includes("HTTPS") || error.message.includes("URL")) return "MARKETPLACE_ENDPOINT_INVALID";
  if (error.message.includes("fingerprint")) return "MARKETPLACE_IDENTITY_CHANGED";
  if (error.message.includes("signature") || error.message.includes("Ed25519")) {
    return "MARKETPLACE_ENDPOINT_UNTRUSTED";
  }
  return "MARKETPLACE_UNAVAILABLE";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) result[key] = canonicalValue(record[key]);
  return result;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeUrlPath(source: string, pathname: string, label: string): void {
  if (source !== source.trim() || /\\|[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error(`${label} contains an unsafe path`);
  }
  const authorityEnd = source.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0].length ?? 0;
  const rawPath = source.slice(authorityEnd).split(/[?#]/, 1)[0] ?? "";
  for (const path of [rawPath, pathname]) {
    for (const segment of path.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new Error(`${label} contains an invalid encoded path`);
      }
      if (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        decoded.includes("\0")
      ) {
        throw new Error(`${label} contains an unsafe path`);
      }
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
