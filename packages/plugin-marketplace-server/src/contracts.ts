export type PluginStatus = "available" | "deprecated";

export interface PublisherRecord {
	id: string;
	displayName: string;
	verified: boolean;
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

export type PluginConfigurationValue = string | number | boolean;

export interface PluginConfigurationFieldBase {
	key: string;
	label: string;
	description?: string;
	group?: string;
	order?: number;
	deprecated?: boolean;
	deprecatedMessage?: string;
	required?: boolean;
	widget?: "model-selector";
	modelFormat?: "model-id" | "provider-model";
}

export type PluginConfigurationField =
	| (PluginConfigurationFieldBase & {
			type: "text" | "textarea" | "path";
			defaultValue?: string;
			placeholder?: string;
			minLength?: number;
			maxLength?: number;
			pattern?: string;
			patternMessage?: string;
	  })
	| (PluginConfigurationFieldBase & {
			type: "secret";
			placeholder?: string;
			minLength?: number;
			maxLength?: number;
			pattern?: string;
			patternMessage?: string;
	  })
	| (PluginConfigurationFieldBase & {
			type: "number";
			defaultValue?: number;
			minimum?: number;
			maximum?: number;
			step?: number;
	  })
	| (PluginConfigurationFieldBase & { type: "boolean"; defaultValue?: boolean })
	| (PluginConfigurationFieldBase & {
			type: "select";
			defaultValue?: string;
			options: Array<{ value: string; label: string; description?: string }>;
	  });

export interface PluginConfigurationSchema {
	version: 1;
	fields: PluginConfigurationField[];
}

export interface MarketplaceArtifactManifest {
	schemaVersion: 1;
	marketplaceId: string;
	artifactId: string;
	plugin: {
		id: string;
		name: string;
		version: string;
		publisherId: string;
	};
	pi: {
		entry: string;
		extensionApi: string;
	};
	desktop: {
		hostProfileVersion: number;
		minVersion?: string;
		maxVersionExclusive?: string;
	};
	target: ArtifactTarget;
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	nativeModules: Array<{
		path: string;
		abi: { kind: "node"; modulesAbi: string } | { kind: "napi"; minimumNapi: string };
	}>;
	executables: Array<{
		path: string;
		osRelease?: string;
		libc?: string;
	}>;
	files: Record<
		string,
		{
			mode: "0644" | "0755";
		}
	>;
}

export interface CatalogArtifact {
	id: string;
	target: ArtifactTarget;
	sha256: string;
	size: number;
	downloadPath: string;
	containsNativeCode: boolean;
	preferred: boolean;
}

export interface CatalogPluginVersion {
	version: string;
	status: PluginStatus;
	changelog: string;
	publishedAt: number;
	desktop: {
		hostProfileVersion: number;
		minVersion?: string;
		maxVersionExclusive?: string;
	};
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	artifacts: CatalogArtifact[];
}

export interface CatalogPlugin {
	id: string;
	name: string;
	description: string;
	publisher: PublisherRecord;
	categories: string[];
	iconAssetId?: string;
	publishedAt: number;
	updatedAt: number;
	versions: CatalogPluginVersion[];
}

export interface CatalogDocument {
	schemaVersion: 1;
	plugins: CatalogPlugin[];
}

export interface MarketplaceRuntimeQuery {
	desktopVersion?: string;
	piVersion?: string;
	nodeVersion?: string;
	platform?: string;
	arch?: string;
	modulesAbi?: string;
	napi?: string;
	osRelease?: string;
	libc?: string;
	toolchain?: string;
	runtimeCompatibilityId?: string;
	includeIncompatible: boolean;
}

export interface PluginRatingAggregate {
	count: number;
	average: number | null;
}

export interface MarketplacePluginSummary {
	id: string;
	name: string;
	description: string;
	publisher: PublisherRecord;
	categories: string[];
	iconAssetId?: string;
	iconUrl?: string;
	latestVersion?: string;
	compatibleVersion?: string;
	capabilities: string[];
	containsNativeCode: boolean;
	status: PluginStatus;
	publishedAt: number;
	updatedAt: number;
	rating: PluginRatingAggregate;
	downloadCount: number;
}

export interface MarketplacePluginPage {
	plugins: MarketplacePluginSummary[];
	nextCursor?: string;
}

export interface MarketplaceArtifactMetadata {
	id: string;
	target: ArtifactTarget;
	sha256: string;
	size: number;
	containsNativeCode: boolean;
	preferred: boolean;
	downloadEndpoint: string;
}

export interface MarketplacePluginVersionDetail {
	version: string;
	status: PluginStatus;
	changelog: string;
	publishedAt: number;
	desktop: CatalogPluginVersion["desktop"];
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	artifacts: MarketplaceArtifactMetadata[];
}

export interface MarketplacePluginDetail extends Omit<CatalogPlugin, "versions"> {
	iconUrl?: string;
	latestVersion?: string;
	versions: MarketplacePluginVersionDetail[];
	rating: PluginRatingAggregate;
	downloadCount: number;
}

export interface StoredArtifact {
	id: string;
	target: ArtifactTarget;
	containsNativeCode: boolean;
	preferred: boolean;
	entry: string;
	sha256: string | null;
	size: number | null;
	uploaded: boolean;
}

export interface StoredPluginVersion {
	version: string;
	status: PluginStatus;
	draft: boolean;
	changelog: string;
	publishedAt: number;
	desktop: CatalogPluginVersion["desktop"];
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	artifacts: StoredArtifact[];
}

export interface StoredPlugin {
	id: string;
	name: string;
	description: string;
	publisher: PublisherRecord;
	categories: string[];
	iconAssetId?: string;
	publishedAt: number;
	updatedAt: number;
	versions: StoredPluginVersion[];
}

export interface AuthUserSummary {
	username: string;
	createdAt: number;
}

export interface AuthSessionResponse {
	token: string;
	expiresAt: number;
	user: AuthUserSummary;
}

export interface AuthMeResponse {
	admin: boolean;
	user?: AuthUserSummary;
	publisherIds: string[];
}

export interface ArtifactUploadContext {
	pluginName: string;
	publisherId: string;
	desktop: CatalogPluginVersion["desktop"];
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	artifact: { id: string; target: ArtifactTarget; entry: string };
}

export interface ArtifactContentInput {
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

export interface ArtifactContent {
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

export interface PluginIconContentInput {
	contentType: string;
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

export interface PluginIconContent {
	assetId: string;
	contentType: string;
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

export interface PublishArtifactAuditContent {
	artifactId: string;
	containsNativeCode: boolean;
	bytes?: Uint8Array;
}

export interface PublisherAdminView extends PublisherRecord {
	members: string[];
}

export interface PublishPluginRequest {
	name: string;
	description: string;
	publisherId: string;
	categories: string[];
	iconAssetId?: string;
}

export interface PublishVersionArtifactRequest {
	id: string;
	target: ArtifactTarget;
	entry: string;
	containsNativeCode: boolean;
	preferred: boolean;
}

export interface PublishVersionRequest {
	version: string;
	changelog: string;
	desktop: CatalogPluginVersion["desktop"];
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	artifacts: PublishVersionArtifactRequest[];
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

export interface PluginRatingEntry {
	username: string;
	stars: number;
	review?: string;
	updatedAt: number;
}

export interface PluginRatingsResponse {
	rating: PluginRatingAggregate;
	histogram: [number, number, number, number, number];
	ratings: PluginRatingEntry[];
}

export interface PluginStatsResponse {
	downloadCount: number;
	downloadsByVersion: Record<string, number>;
	rating: PluginRatingAggregate;
}

export interface WellKnownMarketplaceData {
	protocolVersion: 1;
	marketplaceId: string;
	apiRoot: string;
}

export interface MarketplaceErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, string>;
	};
}
