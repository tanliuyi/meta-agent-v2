import { valid as validSemver } from "semver";
import { parsePluginConfigurationSchema } from "./configuration-schema.ts";
import type {
	ArtifactTarget,
	CatalogArtifact,
	CatalogDocument,
	CatalogPlugin,
	CatalogPluginVersion,
	PluginStatus,
	PublisherRecord,
} from "./contracts.ts";

export const PLUGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
export const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set<PluginStatus>(["available", "deprecated"]);

export function parseCatalogDocument(value: unknown): CatalogDocument {
	const root = objectValue(value, "catalog");
	if (root.schemaVersion !== 1) throw new Error("catalog.schemaVersion must be 1");
	const plugins = arrayValue(root.plugins, "catalog.plugins").map((plugin, index) =>
		parsePlugin(plugin, `catalog.plugins[${index}]`),
	);
	assertUnique(
		plugins.map(({ id }) => id),
		"plugin IDs",
	);
	return { schemaVersion: 1, plugins };
}

function parsePlugin(value: unknown, path: string): CatalogPlugin {
	const record = objectValue(value, path);
	const id = stringValue(record.id, `${path}.id`);
	if (!PLUGIN_ID.test(id)) throw new Error(`${path}.id is invalid`);
	const versions = arrayValue(record.versions, `${path}.versions`).map((version, index) =>
		parseVersion(version, `${path}.versions[${index}]`),
	);
	assertUnique(
		versions.map(({ version }) => version),
		`${path} version IDs`,
	);
	if (versions.length === 0) throw new Error(`${path}.versions cannot be empty`);
	return {
		id,
		name: stringValue(record.name, `${path}.name`),
		description: stringValue(record.description, `${path}.description`),
		publisher: parsePublisher(record.publisher, `${path}.publisher`),
		categories: stringArray(record.categories, `${path}.categories`),
		...(record.iconAssetId === undefined
			? {}
			: { iconAssetId: stringValue(record.iconAssetId, `${path}.iconAssetId`) }),
		publishedAt: timestampValue(record.publishedAt, `${path}.publishedAt`),
		updatedAt: timestampValue(record.updatedAt, `${path}.updatedAt`),
		versions,
	};
}

function parsePublisher(value: unknown, path: string): PublisherRecord {
	const record = objectValue(value, path);
	return {
		id: stringValue(record.id, `${path}.id`),
		displayName: stringValue(record.displayName, `${path}.displayName`),
		verified: booleanValue(record.verified, `${path}.verified`),
	};
}

function parseVersion(value: unknown, path: string): CatalogPluginVersion {
	const record = objectValue(value, path);
	const version = stringValue(record.version, `${path}.version`);
	if (!validSemver(version)) throw new Error(`${path}.version is not semver`);
	const status = stringValue(record.status, `${path}.status`);
	if (!STATUSES.has(status as PluginStatus)) throw new Error(`${path}.status is invalid`);
	const desktop = objectValue(record.desktop, `${path}.desktop`);
	const artifacts = arrayValue(record.artifacts, `${path}.artifacts`).map((artifact, index) =>
		parseArtifact(artifact, `${path}.artifacts[${index}]`),
	);
	assertUnique(
		artifacts.map(({ id }) => id),
		`${path} artifact IDs`,
	);
	if (artifacts.length === 0) throw new Error(`${path}.artifacts cannot be empty`);
	return {
		version,
		status: status as PluginStatus,
		changelog: stringValue(record.changelog, `${path}.changelog`),
		publishedAt: timestampValue(record.publishedAt, `${path}.publishedAt`),
		desktop: parseDesktopCompatibility(desktop, `${path}.desktop`),
		...(record.configuration === undefined
			? {}
			: { configuration: parsePluginConfigurationSchema(record.configuration)! }),
		capabilities: stringArray(record.capabilities, `${path}.capabilities`),
		artifacts,
	};
}

function parseDesktopCompatibility(record: Record<string, unknown>, path: string): CatalogPluginVersion["desktop"] {
	const minVersion =
		record.minVersion === undefined ? undefined : stringValue(record.minVersion, `${path}.minVersion`);
	const maxVersionExclusive =
		record.maxVersionExclusive === undefined
			? undefined
			: stringValue(record.maxVersionExclusive, `${path}.maxVersionExclusive`);
	if (minVersion && !validSemver(minVersion)) throw new Error(`${path}.minVersion is not semver`);
	if (maxVersionExclusive && !validSemver(maxVersionExclusive)) {
		throw new Error(`${path}.maxVersionExclusive is not semver`);
	}
	return {
		hostProfileVersion: positiveInteger(record.hostProfileVersion, `${path}.hostProfileVersion`),
		...(minVersion ? { minVersion } : {}),
		...(maxVersionExclusive ? { maxVersionExclusive } : {}),
	};
}

function parseArtifact(value: unknown, path: string): CatalogArtifact {
	const record = objectValue(value, path);
	const sha256 = stringValue(record.sha256, `${path}.sha256`);
	if (!SHA256.test(sha256)) throw new Error(`${path}.sha256 is invalid`);
	const downloadPath = stringValue(record.downloadPath, `${path}.downloadPath`);
	if (!downloadPath.startsWith("/") || downloadPath.startsWith("//") || downloadPath.includes("..")) {
		throw new Error(`${path}.downloadPath must be a safe absolute URL path`);
	}
	const id = stringValue(record.id, `${path}.id`);
	if (!ARTIFACT_ID.test(id)) throw new Error(`${path}.id is invalid`);
	return {
		id,
		target: parseTarget(record.target, `${path}.target`),
		sha256,
		size: positiveInteger(record.size, `${path}.size`),
		downloadPath,
		containsNativeCode: booleanValue(record.containsNativeCode, `${path}.containsNativeCode`),
		preferred: booleanValue(record.preferred, `${path}.preferred`),
	};
}

export function parseTarget(value: unknown, path: string): ArtifactTarget {
	const record = objectValue(value, path);
	return {
		platform: stringValue(record.platform, `${path}.platform`),
		arch: stringValue(record.arch, `${path}.arch`),
		...optionalStringFields(record, path, [
			"nodeVersion",
			"modulesAbi",
			"minimumNapi",
			"osRelease",
			"libc",
			"toolchain",
			"piVersion",
			"runtimeCompatibilityId",
		]),
	};
}

function optionalStringFields(
	record: Record<string, unknown>,
	path: string,
	keys: Array<keyof ArtifactTarget>,
): Partial<ArtifactTarget> {
	const result: Record<string, string> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined) result[key] = stringValue(value, `${path}.${key}`);
	}
	return result;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value;
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, path: string): string[] {
	return arrayValue(value, path).map((item, index) => stringValue(item, `${path}[${index}]`));
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive integer`);
	return value as number;
}

function timestampValue(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${path} must be a timestamp`);
	return value as number;
}

function assertUnique(values: string[], description: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${description} must be unique`);
}
