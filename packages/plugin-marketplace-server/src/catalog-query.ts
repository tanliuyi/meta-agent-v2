import { compare as compareSemver, valid as validSemver } from "semver";
import type {
	MarketplacePluginPage,
	MarketplacePluginSummary,
	MarketplaceRuntimeQuery,
	PluginRatingAggregate,
	StoredArtifact,
	StoredPlugin,
	StoredPluginVersion,
} from "./contracts.ts";

export interface ListPluginsInput {
	query?: string;
	category?: string;
	cursor?: string;
	limit: number;
	runtime: MarketplaceRuntimeQuery;
}

export interface PluginAggregates {
	rating: PluginRatingAggregate;
	downloadCount: number;
}

export function listPluginPage(
	plugins: StoredPlugin[],
	input: ListPluginsInput,
	aggregates: (pluginId: string) => PluginAggregates,
): MarketplacePluginPage {
	const query = input.query?.toLocaleLowerCase();
	const category = input.category?.toLocaleLowerCase();
	const start = decodeCursor(input.cursor);
	const filtered = plugins.filter((plugin) => {
		if (query) {
			const searchable =
				`${plugin.name}\n${plugin.description}\n${plugin.publisher.displayName}`.toLocaleLowerCase();
			if (!searchable.includes(query)) return false;
		}
		if (category && !plugin.categories.some((entry) => entry.toLocaleLowerCase() === category)) return false;
		if (!input.runtime.includeIncompatible && !compatibleVersion(plugin, input.runtime)) return false;
		return true;
	});
	if (start > filtered.length) throw new Error("CURSOR_OUT_OF_RANGE");
	const page = filtered.slice(start, start + input.limit);
	const next = start + page.length;
	return {
		plugins: page.map((plugin) => summarize(plugin, input.runtime, aggregates(plugin.id))),
		...(next < filtered.length ? { nextCursor: encodeCursor(next) } : {}),
	};
}

export function versionCompatible(version: StoredPluginVersion, runtime: MarketplaceRuntimeQuery): boolean {
	if (version.draft || version.status === "blocked" || version.status === "withdrawn") return false;
	if (runtime.desktopVersion !== undefined && !validSemver(runtime.desktopVersion)) return false;
	if (
		version.desktop.minVersion &&
		(!runtime.desktopVersion || compareSemver(runtime.desktopVersion, version.desktop.minVersion) < 0)
	) {
		return false;
	}
	if (
		version.desktop.maxVersionExclusive &&
		(!runtime.desktopVersion || compareSemver(runtime.desktopVersion, version.desktop.maxVersionExclusive) >= 0)
	) {
		return false;
	}
	return version.artifacts.some((artifact) => artifactCompatible(artifact, runtime));
}

export function newestVersion(versions: StoredPluginVersion[]): StoredPluginVersion | undefined {
	return [...versions].sort((left, right) => compareSemver(right.version, left.version))[0];
}

function compatibleVersion(plugin: StoredPlugin, runtime: MarketplaceRuntimeQuery): StoredPluginVersion | undefined {
	return newestVersion(plugin.versions.filter((version) => versionCompatible(version, runtime)));
}

function summarize(
	plugin: StoredPlugin,
	runtime: MarketplaceRuntimeQuery,
	aggregates: PluginAggregates,
): MarketplacePluginSummary {
	const latest = newestVersion(plugin.versions);
	const compatible = compatibleVersion(plugin, runtime);
	return {
		id: plugin.id,
		name: plugin.name,
		description: plugin.description,
		publisher: { ...plugin.publisher },
		categories: [...plugin.categories],
		...(plugin.iconAssetId ? { iconAssetId: plugin.iconAssetId } : {}),
		...(latest ? { latestVersion: latest.version } : {}),
		...(compatible ? { compatibleVersion: compatible.version } : {}),
		status: (compatible ?? latest)?.status ?? "blocked",
		capabilities: [...((compatible ?? latest)?.capabilities ?? [])],
		containsNativeCode:
			(compatible ?? latest)?.artifacts.some(({ containsNativeCode }) => containsNativeCode) ?? false,
		publishedAt: plugin.publishedAt,
		updatedAt: plugin.updatedAt,
		rating: { ...aggregates.rating },
		downloadCount: aggregates.downloadCount,
	};
}

function artifactCompatible(artifact: StoredArtifact, runtime: MarketplaceRuntimeQuery): boolean {
	const target = artifact.target;
	if (target.platform !== "universal" && target.platform !== runtime.platform) return false;
	if (target.arch !== "universal" && target.arch !== runtime.arch) return false;
	if (target.nodeVersion && target.nodeVersion !== runtime.nodeVersion) return false;
	if (target.modulesAbi && target.modulesAbi !== runtime.modulesAbi) return false;
	if (target.minimumNapi && !minimumNapiCompatible(target.minimumNapi, runtime.napi)) return false;
	if (target.osRelease && target.osRelease !== runtime.osRelease) return false;
	if (target.libc && target.libc !== runtime.libc) return false;
	if (target.toolchain && target.toolchain !== runtime.toolchain) return false;
	if (target.piVersion && target.piVersion !== runtime.piVersion) return false;
	if (target.runtimeCompatibilityId && target.runtimeCompatibilityId !== runtime.runtimeCompatibilityId) return false;
	return true;
}

function minimumNapiCompatible(minimumNapi: string, runtimeNapi: string | undefined): boolean {
	if (!/^[1-9]\d*$/.test(minimumNapi) || !runtimeNapi || !/^[1-9]\d*$/.test(runtimeNapi)) return false;
	const minimum = Number(minimumNapi);
	const actual = Number(runtimeNapi);
	return Number.isSafeInteger(minimum) && Number.isSafeInteger(actual) && actual >= minimum;
}

function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	let source: string;
	try {
		source = Buffer.from(cursor, "base64url").toString("utf8");
	} catch {
		throw new Error("CURSOR_INVALID");
	}
	if (!/^\d+$/.test(source)) throw new Error("CURSOR_INVALID");
	const offset = Number(source);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("CURSOR_INVALID");
	return offset;
}
