import type {
  ListMarketplacePluginsInput,
  MarketplaceEndpointRecord,
  MarketplacePluginPage,
  MarketplacePluginSummary,
} from "../../shared/plugin-marketplace-contracts.ts";
import type { RuntimeCompatibility } from "../../shared/sidecar-contracts.ts";
import type { MarketplaceEndpointSettingsService } from "./marketplace-endpoint-settings-service.ts";
import { appendMarketplaceRuntimeQuery, readBoundedJsonResponse } from "./marketplace-http.ts";

interface MarketplaceCatalogServiceOptions {
  fetch?: typeof fetch;
  now?(): number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  desktopVersion?: string;
  runtimeCompatibility?: RuntimeCompatibility;
}

interface CatalogResponse {
  plugins: MarketplacePluginSummary[];
  nextCursor?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Fetches a bounded, validated catalog only from the saved active endpoint. */
export class MarketplaceCatalogService {
  private readonly endpoints: MarketplaceEndpointSettingsService;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly desktopVersion?: string;
  private readonly runtimeCompatibility?: RuntimeCompatibility;
  private readonly cache = new Map<string, MarketplacePluginPage>();

  constructor(endpoints: MarketplaceEndpointSettingsService, options: MarketplaceCatalogServiceOptions = {}) {
    this.endpoints = endpoints;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.desktopVersion = options.desktopVersion;
    this.runtimeCompatibility = options.runtimeCompatibility;
  }

  async list(input: ListMarketplacePluginsInput = {}): Promise<MarketplacePluginPage> {
    const normalized = normalizeListInput(input);
    const endpoint = await this.activeEndpoint();
    const cacheKey = JSON.stringify([endpoint.marketplaceId, normalized]);
    const url = new URL("plugins", endpoint.apiRoot);
    if (normalized.query) url.searchParams.set("query", normalized.query);
    if (normalized.category) url.searchParams.set("category", normalized.category);
    if (normalized.cursor) url.searchParams.set("cursor", normalized.cursor);
    url.searchParams.set("limit", String(normalized.limit));
    if (this.desktopVersion) url.searchParams.set("desktopVersion", this.desktopVersion);
    if (this.runtimeCompatibility) appendMarketplaceRuntimeQuery(url, this.runtimeCompatibility);
    try {
      const response = await this.fetchCatalog(url);
      const page: MarketplacePluginPage = {
        marketplaceId: endpoint.marketplaceId,
        plugins: response.plugins,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        source: "network",
        stale: false,
        fetchedAt: this.now(),
      };
      this.cache.set(cacheKey, clonePage(page));
      return page;
    } catch (error) {
      const cached = this.cache.get(cacheKey);
      if (cached) return { ...clonePage(cached), source: "cache", stale: true };
      throw error;
    }
  }

  private async activeEndpoint(): Promise<MarketplaceEndpointRecord> {
    const snapshot = await this.endpoints.getSettings();
    if (!snapshot.activeMarketplaceId) {
      throw Object.assign(new Error("Marketplace API URL is not configured"), {
        code: "MARKETPLACE_ENDPOINT_NOT_CONFIGURED",
      });
    }
    const endpoint = snapshot.endpoints.find(
      (entry) => entry.marketplaceId === snapshot.activeMarketplaceId && entry.active,
    );
    if (!endpoint) throw new Error("Active marketplace endpoint record is unavailable");
    return endpoint;
  }

  private async fetchCatalog(url: URL): Promise<CatalogResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Marketplace catalog request failed with HTTP ${response.status}`);
      return parseCatalogResponse(
        await readBoundedJsonResponse(response, this.maxResponseBytes, "Marketplace catalog response"),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeListInput(
  input: ListMarketplacePluginsInput,
): Required<Pick<ListMarketplacePluginsInput, "limit">> & Omit<ListMarketplacePluginsInput, "limit"> {
  if (!input || typeof input !== "object") throw new TypeError("Invalid marketplace catalog input");
  for (const value of [input.query, input.category, input.cursor]) {
    if (value !== undefined && typeof value !== "string") throw new TypeError("Invalid marketplace catalog input");
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT)) {
    throw new TypeError("Marketplace catalog limit must be between 1 and 100");
  }
  return {
    ...(input.query?.trim() ? { query: input.query.trim().slice(0, 200) } : {}),
    ...(input.category?.trim() ? { category: input.category.trim().slice(0, 100) } : {}),
    ...(input.cursor?.trim() ? { cursor: input.cursor.trim().slice(0, 500) } : {}),
    limit: input.limit ?? DEFAULT_LIMIT,
  };
}

function parseCatalogResponse(value: unknown): CatalogResponse {
  if (!isPlainObject(value) || !Array.isArray(value.plugins)) {
    throw new Error("Marketplace catalog response is invalid");
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
    throw new Error("Marketplace catalog response nextCursor is invalid");
  }
  return {
    plugins: value.plugins.map(parsePluginSummary),
    ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
  };
}

function parsePluginSummary(value: unknown): MarketplacePluginSummary {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !isPlainObject(value.publisher) ||
    typeof value.publisher.id !== "string" ||
    typeof value.publisher.displayName !== "string" ||
    typeof value.publisher.verified !== "boolean" ||
    !Array.isArray(value.categories) ||
    !value.categories.every((entry) => typeof entry === "string") ||
    (value.iconAssetId !== undefined && typeof value.iconAssetId !== "string") ||
    (value.latestVersion !== undefined && typeof value.latestVersion !== "string") ||
    (value.compatibleVersion !== undefined && typeof value.compatibleVersion !== "string") ||
    typeof value.containsNativeCode !== "boolean" ||
    (value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => typeof entry === "string"))) ||
    !isPluginStatus(value.status) ||
    typeof value.publishedAt !== "number" ||
    !Number.isFinite(value.publishedAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error("Marketplace catalog plugin entry is invalid");
  }
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    publisher: {
      id: value.publisher.id,
      displayName: value.publisher.displayName,
      verified: value.publisher.verified,
    },
    categories: [...value.categories],
    ...(value.iconAssetId ? { iconAssetId: value.iconAssetId } : {}),
    ...(value.latestVersion ? { latestVersion: value.latestVersion } : {}),
    ...(value.compatibleVersion ? { compatibleVersion: value.compatibleVersion } : {}),
    containsNativeCode: value.containsNativeCode,
    ...(value.capabilities ? { capabilities: [...value.capabilities] } : {}),
    status: value.status,
    publishedAt: value.publishedAt,
    updatedAt: value.updatedAt,
  };
}

function clonePage(page: MarketplacePluginPage): MarketplacePluginPage {
  return {
    ...page,
    plugins: page.plugins.map((plugin) => ({
      ...plugin,
      publisher: { ...plugin.publisher },
      categories: [...plugin.categories],
      ...(plugin.capabilities ? { capabilities: [...plugin.capabilities] } : {}),
    })),
  };
}

function isPluginStatus(value: unknown): value is MarketplacePluginSummary["status"] {
  return value === "available" || value === "deprecated" || value === "withdrawn" || value === "blocked";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
