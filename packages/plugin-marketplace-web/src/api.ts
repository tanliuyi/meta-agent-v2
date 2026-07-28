export type PluginStatus = "available" | "deprecated" | "withdrawn" | "blocked";

export interface PublisherRecord {
  id: string;
  displayName: string;
  verified: boolean;
}

export interface RatingAggregate {
  count: number;
  average: number | null;
}

export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  publisher: PublisherRecord;
  categories: string[];
  latestVersion?: string;
  compatibleVersion?: string;
  capabilities: string[];
  containsNativeCode: boolean;
  status: PluginStatus;
  publishedAt: number;
  updatedAt: number;
  rating: RatingAggregate;
  downloadCount: number;
}

export interface PluginPage {
  plugins: PluginSummary[];
  nextCursor?: string;
}

export interface ArtifactTarget {
  platform: string;
  arch: string;
  nodeVersion?: string;
  modulesAbi?: string;
  minimumNapi?: string;
  osRelease?: string;
  libc?: string;
  toolchain?: string;
  piVersion?: string;
  runtimeCompatibilityId?: string;
}

export interface ArtifactMetadata {
  id: string;
  target: ArtifactTarget;
  sha256: string;
  size: number;
  containsNativeCode: boolean;
  preferred: boolean;
  downloadEndpoint: string;
}

export interface PluginVersionDetail {
  version: string;
  status: PluginStatus;
  changelog: string;
  publishedAt: number;
  desktop: {
    hostProfileVersion: number;
    minVersion?: string;
    maxVersionExclusive?: string;
  };
  capabilities: string[];
  artifacts: ArtifactMetadata[];
}

export interface PluginDetail
  extends Omit<PluginSummary, "compatibleVersion" | "capabilities" | "containsNativeCode" | "status"> {
  versions: PluginVersionDetail[];
}

export interface RatingEntry {
  username: string;
  stars: number;
  review?: string;
  updatedAt: number;
}

export interface RatingsResponse {
  rating: RatingAggregate;
  histogram: [number, number, number, number, number];
  ratings: RatingEntry[];
}

export interface AuthUser {
  username: string;
  createdAt: number;
}

export interface AuthSession {
  token: string;
  expiresAt: number;
  user: AuthUser;
}

export interface AuthMe {
  admin: boolean;
  user?: AuthUser;
  publisherIds: string[];
}

export interface DownloadMetadata {
  url: string;
  sha256: string;
  size: number;
}

export interface PublishArtifactState {
  id: string;
  uploaded: boolean;
}

export interface PublishVersionState {
  version: string;
  status: PluginStatus;
  draft: boolean;
  artifacts: PublishArtifactState[];
}

export interface PublishPluginState {
  id: string;
  name: string;
  description: string;
  publisherId: string;
  categories: string[];
  iconAssetId?: string;
  versions: PublishVersionState[];
}

export interface PublishPluginInput {
  name: string;
  description: string;
  publisherId: string;
  categories: string[];
  iconAssetId?: string;
}

export interface PublishArtifactInput {
  id: string;
  target: ArtifactTarget;
  entry: string;
  containsNativeCode: boolean;
  preferred: boolean;
}

export interface PublishVersionInput {
  version: string;
  changelog: string;
  desktop: {
    hostProfileVersion: number;
    minVersion?: string;
    maxVersionExclusive?: string;
  };
  capabilities: string[];
  artifacts: PublishArtifactInput[];
}

export interface ArtifactUploadResult {
  pluginId: string;
  version: string;
  artifactId: string;
  sha256: string;
  size: number;
}

interface MarketplaceErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

const configuredBaseUrl = import.meta.env.VITE_MARKETPLACE_API_BASE_URL || "/marketplace-api";
const API_BASE_URL = configuredBaseUrl.replace(/\/$/, "");

export class MarketplaceApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MarketplaceApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof Blob)) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    let body: MarketplaceErrorBody | undefined;
    try {
      body = (await response.json()) as MarketplaceErrorBody;
    } catch {
      body = undefined;
    }
    throw new MarketplaceApiError(
      body?.error?.message || `Marketplace request failed (${response.status})`,
      response.status,
      body?.error?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listPlugins(input: { query?: string; category?: string; cursor?: string }): Promise<PluginPage> {
  const search = new URLSearchParams({ limit: "24", includeIncompatible: "true" });
  if (input.query) search.set("query", input.query);
  if (input.category) search.set("category", input.category);
  if (input.cursor) search.set("cursor", input.cursor);
  return request<PluginPage>(`/v1/plugins?${search}`);
}

export function getPlugin(pluginId: string): Promise<PluginDetail> {
  return request<PluginDetail>(`/v1/plugins/${encodeURIComponent(pluginId)}`);
}

export function getRatings(pluginId: string): Promise<RatingsResponse> {
  return request<RatingsResponse>(`/v1/plugins/${encodeURIComponent(pluginId)}/ratings`);
}

export function getDownload(pluginId: string, version: string, artifactId: string): Promise<DownloadMetadata> {
  return request<DownloadMetadata>(
    `/v1/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/artifacts/${encodeURIComponent(artifactId)}/download`,
  );
}

export function authenticate(mode: "login" | "register", username: string, password: string): Promise<AuthSession> {
  return request<AuthSession>(`/v1/auth/${mode}`, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function getCurrentUser(token: string, signal?: AbortSignal): Promise<AuthMe> {
  return request<AuthMe>("/v1/auth/me", { signal }, token);
}

export function logout(token: string): Promise<void> {
  return request<void>("/v1/auth/logout", { method: "POST" }, token);
}

export function ratePlugin(pluginId: string, stars: number, review: string, token: string): Promise<void> {
  return request<void>(
    `/v1/plugins/${encodeURIComponent(pluginId)}/rating`,
    {
      method: "PUT",
      body: JSON.stringify({ stars, ...(review.trim() ? { review: review.trim() } : {}) }),
    },
    token,
  );
}

export function deleteRating(pluginId: string, token: string): Promise<void> {
  return request<void>(`/v1/plugins/${encodeURIComponent(pluginId)}/rating`, { method: "DELETE" }, token);
}

export function listManagedPlugins(token: string): Promise<{ plugins: PublishPluginState[] }> {
  return request<{ plugins: PublishPluginState[] }>("/v1/publish/plugins", {}, token);
}

export function upsertManagedPlugin(
  pluginId: string,
  input: PublishPluginInput,
  token: string,
): Promise<{ plugin: PublishPluginState }> {
  return request<{ plugin: PublishPluginState }>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}`,
    { method: "PUT", body: JSON.stringify(input) },
    token,
  );
}

export function createManagedVersion(
  pluginId: string,
  input: PublishVersionInput,
  token: string,
): Promise<{ pluginId: string; version: PublishVersionState }> {
  return request<{ pluginId: string; version: PublishVersionState }>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}/versions`,
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export function uploadManagedArtifact(
  pluginId: string,
  version: string,
  artifactId: string,
  file: File,
  token: string,
): Promise<ArtifactUploadResult> {
  return request<ArtifactUploadResult>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/artifacts/${encodeURIComponent(artifactId)}`,
    { method: "PUT", headers: { "content-type": "application/zip" }, body: file },
    token,
  );
}

export function publishManagedVersion(pluginId: string, version: string, token: string): Promise<void> {
  return request<void>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/publish`,
    { method: "POST" },
    token,
  );
}

export function deprecateManagedVersion(pluginId: string, version: string, token: string): Promise<void> {
  return request<void>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/deprecate`,
    { method: "POST" },
    token,
  );
}

export function deleteManagedDraft(pluginId: string, version: string, token: string): Promise<void> {
  return request<void>(
    `/v1/publish/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}`,
    { method: "DELETE" },
    token,
  );
}
