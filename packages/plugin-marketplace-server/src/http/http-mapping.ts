import { rcompare } from "semver";
import type { PluginAggregates } from "../catalog-query.ts";
import type {
	MarketplaceArtifactMetadata,
	MarketplacePluginDetail,
	MarketplacePluginVersionDetail,
	StoredArtifact,
	StoredPlugin,
	StoredPluginVersion,
} from "../contracts.ts";

export function pluginDetail(
	plugin: StoredPlugin,
	publicBaseUrl: string,
	aggregates: PluginAggregates,
): MarketplacePluginDetail {
	const latestVersion = [...plugin.versions].sort((left, right) => rcompare(left.version, right.version))[0]?.version;
	return {
		id: plugin.id,
		name: plugin.name,
		description: plugin.description,
		publisher: { ...plugin.publisher },
		categories: [...plugin.categories],
		...(plugin.iconAssetId ? { iconAssetId: plugin.iconAssetId } : {}),
		publishedAt: plugin.publishedAt,
		updatedAt: plugin.updatedAt,
		...(latestVersion ? { latestVersion } : {}),
		versions: plugin.versions.map((version) => versionDetail(plugin.id, version, publicBaseUrl)),
		rating: { ...aggregates.rating },
		downloadCount: aggregates.downloadCount,
	};
}

export function versionDetail(
	pluginId: string,
	version: StoredPluginVersion,
	publicBaseUrl: string,
): MarketplacePluginVersionDetail {
	return {
		version: version.version,
		status: version.status,
		changelog: version.changelog,
		publishedAt: version.publishedAt,
		desktop: { ...version.desktop },
		...(version.configuration ? { configuration: structuredClone(version.configuration) } : {}),
		capabilities: [...version.capabilities],
		artifacts: version.artifacts.map((artifact) =>
			artifactMetadata(pluginId, version.version, artifact, publicBaseUrl),
		),
	};
}

export function artifactMetadata(
	pluginId: string,
	version: string,
	artifact: StoredArtifact,
	publicBaseUrl: string,
): MarketplaceArtifactMetadata {
	if (artifact.sha256 === null || artifact.size === null) {
		throw new Error(`Stored artifact content is missing: ${pluginId}@${version}/${artifact.id}`);
	}
	return {
		id: artifact.id,
		target: { ...artifact.target },
		sha256: artifact.sha256,
		size: artifact.size,
		containsNativeCode: artifact.containsNativeCode,
		preferred: artifact.preferred,
		downloadEndpoint: `${publicBaseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
	};
}

export function artifactUrl(publicBaseUrl: string, pluginId: string, version: string, artifactId: string): URL {
	return new URL(
		`${publicBaseUrl}/v1/artifacts/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/${encodeURIComponent(artifactId)}`,
	);
}
