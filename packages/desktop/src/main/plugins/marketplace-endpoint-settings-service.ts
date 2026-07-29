import { createHash, randomUUID } from "node:crypto";
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
export type MarketplaceEndpoint = MarketplaceEndpointRecord;

type StoredMarketplaceEndpointRecord = MarketplaceEndpointRecord;

interface MarketplaceEndpointFileData {
  version?: number;
  activeMarketplaceId?: string;
  endpoints?: StoredMarketplaceEndpointRecord[];
  [key: string]: unknown;
}

interface CurrentEndpointSource {
  revision: string;
  data: MarketplaceEndpointFileData;
  injectedMarketplaceId?: string;
}

interface MarketplaceWellKnown {
  protocolVersion: number;
  marketplaceId: string;
  apiRoot: string;
}

interface MarketplaceEndpointSettingsServiceOptions {
  createId?(): string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  defaultEndpoint?: MarketplaceEndpoint;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_RESULTS = 256;

/** Stores the selected marketplace endpoint and resolves its API metadata. */
export class MarketplaceEndpointSettingsService {
  readonly path: string;
  private saveTail: Promise<void> = Promise.resolve();
  private readonly createId: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly defaultEndpoint?: MarketplaceEndpoint;
  private readonly requestResults = new Map<string, SaveMarketplaceEndpointResult>();

  constructor(userDataDir: string, options: MarketplaceEndpointSettingsServiceOptions = {}) {
    this.path = join(userDataDir, "plugins", "marketplace-endpoints.json");
    this.createId = options.createId ?? randomUUID;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (options.defaultEndpoint) {
      assertEndpointRecord(options.defaultEndpoint);
      assertEndpointUrls(options.defaultEndpoint);
      if (!options.defaultEndpoint.active) throw new Error("Default marketplace endpoint must be active");
      this.defaultEndpoint = cloneEndpoint(options.defaultEndpoint);
    }
  }

  async getSettings(): Promise<MarketplaceEndpointSettingsSnapshot> {
    return snapshotFromCurrent(await this.readCurrent());
  }

  async getEndpoint(marketplaceId: string): Promise<MarketplaceEndpoint> {
    const current = await this.readCurrent();
    const endpoint = current.data.endpoints?.find((entry) => entry.marketplaceId === marketplaceId);
    if (!endpoint) throw new Error(`Marketplace endpoint is unavailable: ${marketplaceId}`);
    return cloneEndpoint(endpoint);
  }

  async getActiveEndpoint(): Promise<MarketplaceEndpoint> {
    const current = await this.readCurrent();
    const active = current.data.endpoints?.find(
      (endpoint) => endpoint.marketplaceId === current.data.activeMarketplaceId && endpoint.active,
    );
    if (!active) throw new Error("Marketplace API URL is not configured");
    return cloneEndpoint(active);
  }

  async testEndpoint(input: TestMarketplaceEndpointInput): Promise<TestMarketplaceEndpointResult> {
    assertTestInput(input);
    try {
      const endpoint = await this.discover(normalizeBaseUrl(input.baseUrl));
      return { status: "ready", endpoint: endpointSnapshot(endpoint) };
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
        return this.cacheResult(input.requestId, {
          status: "conflict",
          current: snapshotFromCurrent(current),
        });
      }
      const endpoint = await this.discover(baseUrl);
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
      return this.cacheResult(input.requestId, {
        status: "saved",
        snapshot: snapshotFromCurrent(await this.readCurrent()),
      });
    } finally {
      await release();
    }
  }

  private async discover(baseUrl: string): Promise<StoredMarketplaceEndpointRecord> {
    const wellKnownUrl = new URL(".well-known/meta-agent-marketplace.json", baseUrl);
    const value = await this.fetchJson(wellKnownUrl, this.maxResponseBytes);
    const document = parseWellKnown(unwrapEnvelope(value));
    return {
      marketplaceId: document.marketplaceId,
      baseUrl,
      apiRoot: normalizeDiscoveredUrl(document.apiRoot, baseUrl),
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

  private cacheResult(requestId: string, result: SaveMarketplaceEndpointResult): SaveMarketplaceEndpointResult {
    if (this.requestResults.size >= MAX_REQUEST_RESULTS) {
      const oldest = this.requestResults.keys().next().value;
      if (typeof oldest === "string") this.requestResults.delete(oldest);
    }
    this.requestResults.set(requestId, result);
    return result;
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
  defaultEndpoint: MarketplaceEndpoint | undefined,
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

function cloneEndpoint(endpoint: MarketplaceEndpoint): MarketplaceEndpoint {
  return { ...endpoint };
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

function normalizeDiscoveredUrl(value: string, baseUrl: string): string {
  const url = new URL(value, baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Marketplace metadata contains an unsafe URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Marketplace metadata URL must use HTTP or HTTPS");
  }
  assertSafeUrlPath(value, url.pathname, "Marketplace metadata URL");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

function assertEndpointUrls(endpoint: MarketplaceEndpoint): void {
  if (normalizeBaseUrl(endpoint.baseUrl) !== endpoint.baseUrl) {
    throw new Error("Default marketplace base URL is not normalized");
  }
  if (normalizeDiscoveredUrl(endpoint.apiRoot, endpoint.baseUrl) !== endpoint.apiRoot) {
    throw new Error("Default marketplace API root is not normalized");
  }
}

function snapshotFromCurrent(current: CurrentEndpointSource): MarketplaceEndpointSettingsSnapshot {
  return {
    revision: current.revision,
    ...(current.data.activeMarketplaceId ? { activeMarketplaceId: current.data.activeMarketplaceId } : {}),
    endpoints: (current.data.endpoints ?? []).map(endpointSnapshot),
  };
}

function unwrapEnvelope(value: unknown): unknown {
  return isPlainObject(value) && "data" in value ? value.data : value;
}

function parseWellKnown(value: unknown): MarketplaceWellKnown {
  if (!isPlainObject(value)) throw new Error("Marketplace well-known document must be an object");
  if (value.protocolVersion !== MARKETPLACE_PROTOCOL_VERSION) {
    throw new Error("Marketplace protocol version is unsupported");
  }
  if (
    typeof value.marketplaceId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value.marketplaceId) ||
    typeof value.apiRoot !== "string"
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
    typeof input.baseUrl !== "string"
  ) {
    throw new TypeError("Invalid marketplace endpoint save input");
  }
}

function endpointSnapshot(endpoint: StoredMarketplaceEndpointRecord): MarketplaceEndpointRecord {
  return cloneEndpoint(endpoint);
}

function endpointErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "MARKETPLACE_UNAVAILABLE";
  if (error.message.includes("HTTPS") || error.message.includes("URL")) return "MARKETPLACE_ENDPOINT_INVALID";
  return "MARKETPLACE_UNAVAILABLE";
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
