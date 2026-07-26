export type PluginStatus = "available" | "deprecated" | "withdrawn" | "blocked";

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
			sha256: string;
			size: number;
			mode: "0644" | "0755";
		}
	>;
}

export interface MarketplaceArtifactSignature {
	algorithm: "ed25519";
	keyId: string;
	value: string;
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

export interface CatalogRevocation {
	pluginId: string;
	version: string;
	artifactIds?: string[];
	status: "withdrawn" | "blocked";
	reasonCode: string;
	message: string;
	replacementVersion?: string;
}

export interface CatalogDocument {
	schemaVersion: 1;
	plugins: CatalogPlugin[];
	revocations: CatalogRevocation[];
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

export interface MarketplacePluginSummary {
	id: string;
	name: string;
	description: string;
	publisher: PublisherRecord;
	categories: string[];
	iconAssetId?: string;
	latestVersion?: string;
	compatibleVersion?: string;
	capabilities: string[];
	containsNativeCode: boolean;
	status: PluginStatus;
	publishedAt: number;
	updatedAt: number;
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
	capabilities: string[];
	artifacts: MarketplaceArtifactMetadata[];
}

export interface MarketplacePluginDetail extends Omit<CatalogPlugin, "versions"> {
	latestVersion?: string;
	versions: MarketplacePluginVersionDetail[];
}

export interface SignedEnvelope<T> {
	data: T;
	signature: MarketplaceArtifactSignature;
}

export interface WellKnownMarketplaceData {
	protocolVersion: 1;
	marketplaceId: string;
	apiRoot: string;
	artifactOrigins: string[];
	signing: {
		algorithm: "ed25519";
		keyId: string;
		fingerprint: string;
		publicKey: string;
	};
}

export interface MarketplaceRevocationData {
	marketplaceId: string;
	sequence: number;
	issuedAt: number;
	nextUpdateAt: number;
	revokedKeys: Array<{ keyId: string; reasonCode: string }>;
	pluginVersions: CatalogRevocation[];
}

export interface MarketplaceErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, string>;
	};
}
