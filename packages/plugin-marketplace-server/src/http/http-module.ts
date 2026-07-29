import { type DynamicModule, Module, Param, Req, Res, type Type } from "@nestjs/common";
import { extractPayloadArchive } from "../artifact-builder.ts";
import type {
	MarketplaceArtifactMetadata,
	MarketplacePluginDetail,
	MarketplacePluginVersionDetail,
	MarketplaceRuntimeQuery,
	StoredPlugin,
	StoredPluginVersion,
	WellKnownMarketplaceData,
} from "../contracts.ts";
import { createAdminControllers } from "./http-admin.ts";
import { createAuthControllers } from "./http-auth.ts";
import { createCommunityControllers } from "./http-community.ts";
import { applyController, applyParameter, applyRoute } from "./http-decorators.ts";
import { artifactMetadata, artifactUrl, pluginDetail, versionDetail } from "./http-mapping.ts";
import { createPublishControllers } from "./http-publish.ts";
import { badRequest, type MarketplaceHttpRuntime, mapStoreErrors, notFound } from "./http-util.ts";

export type { MarketplaceHttpRuntime } from "./http-util.ts";

interface RequestLike {
	query: Record<string, unknown>;
}

interface DownloadRequestLike {
	method: string;
}

interface ResponseLike {
	setHeader(name: string, value: string | number): void;
	send(body: Uint8Array): unknown;
}

export function createMarketplaceHttpModule(runtime: MarketplaceHttpRuntime): DynamicModule {
	// --- query parsing helpers (local to avoid circular deps) ---

	function parseLimit(value: unknown): number {
		if (value === undefined) return 20;
		const source = queryString(value, "limit");
		if (!/^\d+$/.test(source)) throw badRequest("QUERY_INVALID", "limit must be an integer");
		const limit = Number(source);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw badRequest("QUERY_INVALID", "limit must be between 1 and 100");
		}
		return limit;
	}

	function parseBoolean(value: unknown, name: string, fallback: boolean): boolean {
		if (value === undefined) return fallback;
		const source = queryString(value, name);
		if (source === "true") return true;
		if (source === "false") return false;
		throw badRequest("QUERY_INVALID", `${name} must be true or false`);
	}

	function optionalQueryString(value: unknown, name: string): string | undefined {
		return value === undefined ? undefined : queryString(value, name);
	}

	function queryString(value: unknown, name: string): string {
		if (typeof value !== "string" || value.length === 0 || value.length > 256) {
			throw badRequest("QUERY_INVALID", `${name} must be a non-empty string of at most 256 characters`);
		}
		return value;
	}

	function parseRuntimeQuery(query: Record<string, unknown>): MarketplaceRuntimeQuery {
		return {
			...(optionalQueryString(query.desktopVersion, "desktopVersion")
				? { desktopVersion: optionalQueryString(query.desktopVersion, "desktopVersion") }
				: {}),
			...(optionalQueryString(query.piVersion, "piVersion")
				? { piVersion: optionalQueryString(query.piVersion, "piVersion") }
				: {}),
			...(optionalQueryString(query.nodeVersion, "nodeVersion")
				? { nodeVersion: optionalQueryString(query.nodeVersion, "nodeVersion") }
				: {}),
			...(optionalQueryString(query.platform, "platform")
				? { platform: optionalQueryString(query.platform, "platform") }
				: {}),
			...(optionalQueryString(query.arch, "arch") ? { arch: optionalQueryString(query.arch, "arch") } : {}),
			...(optionalQueryString(query.modulesAbi, "modulesAbi")
				? { modulesAbi: optionalQueryString(query.modulesAbi, "modulesAbi") }
				: {}),
			...(optionalQueryString(query.napi, "napi") ? { napi: optionalQueryString(query.napi, "napi") } : {}),
			...(optionalQueryString(query.osRelease, "osRelease")
				? { osRelease: optionalQueryString(query.osRelease, "osRelease") }
				: {}),
			...(optionalQueryString(query.libc, "libc") ? { libc: optionalQueryString(query.libc, "libc") } : {}),
			...(optionalQueryString(query.toolchain, "toolchain")
				? { toolchain: optionalQueryString(query.toolchain, "toolchain") }
				: {}),
			...(optionalQueryString(query.runtimeCompatibilityId, "runtimeCompatibilityId")
				? {
						runtimeCompatibilityId: optionalQueryString(query.runtimeCompatibilityId, "runtimeCompatibilityId"),
					}
				: {}),
			includeIncompatible: parseBoolean(query.includeIncompatible, "includeIncompatible", false),
		};
	}
	class HealthController {
		health(): Record<string, string> {
			return {
				status: "ok",
				marketplaceId: runtime.config.marketplaceId,
			};
		}
	}

	class DiscoveryController {
		discovery(): WellKnownMarketplaceData {
			return {
				protocolVersion: 1,
				marketplaceId: runtime.config.marketplaceId,
				apiRoot: `${runtime.config.publicBaseUrl}/v1`,
			};
		}
	}

	class PluginsController {
		async list(request: RequestLike) {
			const query = request.query;
			const limit = parseLimit(query.limit);
			const runtimeQuery = parseRuntimeQuery(query);
			try {
				return await runtime.store.list({
					...(optionalQueryString(query.query, "query")
						? { query: optionalQueryString(query.query, "query") }
						: {}),
					...(optionalQueryString(query.category, "category")
						? { category: optionalQueryString(query.category, "category") }
						: {}),
					...(optionalQueryString(query.cursor, "cursor")
						? { cursor: optionalQueryString(query.cursor, "cursor") }
						: {}),
					limit,
					runtime: runtimeQuery,
				});
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("CURSOR_")) {
					throw badRequest(error.message, "Pagination cursor is invalid");
				}
				throw error;
			}
		}

		async detail(pluginId: string): Promise<MarketplacePluginDetail> {
			const plugin = await requirePlugin(runtime, pluginId);
			const aggregates = await runtime.store.pluginAggregates(pluginId);
			return pluginDetail(plugin, runtime.config.publicBaseUrl, aggregates);
		}

		async versions(pluginId: string): Promise<MarketplacePluginVersionDetail[]> {
			const plugin = await requirePlugin(runtime, pluginId);
			return plugin.versions.map((version) => versionDetail(pluginId, version, runtime.config.publicBaseUrl));
		}

		async version(pluginId: string, version: string): Promise<MarketplacePluginVersionDetail> {
			const found = await runtime.store.getPublicVersion(pluginId, version);
			if (!found) throw notFound("PLUGIN_VERSION_NOT_FOUND", `Plugin version not found: ${pluginId}@${version}`);
			return versionDetail(pluginId, found, runtime.config.publicBaseUrl);
		}

		async artifacts(pluginId: string, version: string): Promise<{ artifacts: MarketplaceArtifactMetadata[] }> {
			const found = await requireAvailableVersion(runtime, pluginId, version);
			return {
				artifacts: found.artifacts.map((artifact) =>
					artifactMetadata(pluginId, version, artifact, runtime.config.publicBaseUrl),
				),
			};
		}

		async download(pluginId: string, version: string, artifactId: string) {
			const found = await requireAvailableVersion(runtime, pluginId, version);
			const artifact = found.artifacts.find(({ id }) => id === artifactId);
			if (!artifact || artifact.sha256 === null || artifact.size === null) {
				throw notFound("PLUGIN_ARTIFACT_NOT_FOUND", `Plugin artifact not found: ${artifactId}`);
			}
			if (artifact.containsNativeCode) {
				throw badRequest("PAYLOAD_NATIVE_UNSUPPORTED", "Native plugin artifacts are not available for download");
			}
			const content = await runtime.store.getArtifactContent(pluginId, version, artifactId);
			if (!content) throw notFound("PLUGIN_ARTIFACT_NOT_FOUND", `Plugin artifact not found: ${artifactId}`);
			mapStoreErrors(() => extractPayloadArchive(content.bytes, 5 * runtime.config.maxArtifactBytes));
			const url = artifactUrl(runtime.config.publicBaseUrl, pluginId, version, artifactId);
			return {
				pluginId,
				version,
				artifactId,
				url: url.href,
				sha256: artifact.sha256,
				size: artifact.size,
			};
		}
	}

	class ArtifactsController {
		async bytes(
			pluginId: string,
			version: string,
			artifactId: string,
			request: DownloadRequestLike,
			response: ResponseLike,
		): Promise<unknown> {
			const found = await requireAvailableVersion(runtime, pluginId, version);
			const metadata = found.artifacts.find(({ id }) => id === artifactId);
			if (metadata?.containsNativeCode) {
				throw badRequest("PAYLOAD_NATIVE_UNSUPPORTED", "Native plugin artifacts are not available for download");
			}
			const artifact = await runtime.store.getArtifactContent(pluginId, version, artifactId);
			if (!artifact) {
				throw notFound("PLUGIN_ARTIFACT_NOT_FOUND", `Plugin artifact not found: ${artifactId}`);
			}
			mapStoreErrors(() => extractPayloadArchive(artifact.bytes, 5 * runtime.config.maxArtifactBytes));
			// Express routes HEAD to this GET handler; only count downloads that transfer bytes.
			if (request.method === "GET") {
				await runtime.store.incrementDownload(pluginId, version, artifactId);
			}
			response.setHeader("content-type", "application/vnd.meta-agent.plugin+zip");
			response.setHeader("content-length", artifact.size);
			response.setHeader("content-disposition", 'attachment; filename="plugin.meta-plugin"');
			response.setHeader("cache-control", "public, max-age=31536000, immutable");
			response.setHeader("etag", `"sha256-${artifact.sha256}"`);
			return response.send(artifact.bytes);
		}
	}

	applyController(HealthController, "");
	applyRoute(HealthController.prototype, "health", "get", "health");

	applyController(DiscoveryController, "");
	applyRoute(DiscoveryController.prototype, "discovery", "get", ".well-known/meta-agent-marketplace.json");

	applyController(PluginsController, "v1/plugins");
	applyRoute(PluginsController.prototype, "list", "get", "");
	applyParameter(PluginsController.prototype, "list", 0, Req());
	applyRoute(PluginsController.prototype, "detail", "get", ":pluginId");
	applyParameter(PluginsController.prototype, "detail", 0, Param("pluginId"));
	applyRoute(PluginsController.prototype, "versions", "get", ":pluginId/versions");
	applyParameter(PluginsController.prototype, "versions", 0, Param("pluginId"));
	applyRoute(PluginsController.prototype, "version", "get", ":pluginId/versions/:version");
	applyParameter(PluginsController.prototype, "version", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "version", 1, Param("version"));
	applyRoute(PluginsController.prototype, "artifacts", "get", ":pluginId/versions/:version/artifacts");
	applyParameter(PluginsController.prototype, "artifacts", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "artifacts", 1, Param("version"));
	applyRoute(
		PluginsController.prototype,
		"download",
		"get",
		":pluginId/versions/:version/artifacts/:artifactId/download",
	);
	applyParameter(PluginsController.prototype, "download", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "download", 1, Param("version"));
	applyParameter(PluginsController.prototype, "download", 2, Param("artifactId"));

	applyController(ArtifactsController, "v1/artifacts");
	applyRoute(ArtifactsController.prototype, "bytes", "get", ":pluginId/:version/:artifactId");
	applyParameter(ArtifactsController.prototype, "bytes", 0, Param("pluginId"));
	applyParameter(ArtifactsController.prototype, "bytes", 1, Param("version"));
	applyParameter(ArtifactsController.prototype, "bytes", 2, Param("artifactId"));
	applyParameter(ArtifactsController.prototype, "bytes", 3, Req());
	applyParameter(ArtifactsController.prototype, "bytes", 4, Res());

	class MarketplaceModule {
		async onApplicationShutdown(): Promise<void> {
			await runtime.store.close();
		}
	}
	Module({
		controllers: [
			HealthController,
			DiscoveryController,
			PluginsController,
			ArtifactsController,
			...createAuthControllers(runtime),
			...createAdminControllers(runtime),
			...createPublishControllers(runtime),
			...createCommunityControllers(runtime),
		],
	})(MarketplaceModule);

	return { module: MarketplaceModule as Type<unknown> };
}

async function requirePlugin(runtime: MarketplaceHttpRuntime, pluginId: string): Promise<StoredPlugin> {
	const plugin = await runtime.store.getPublicPlugin(pluginId);
	if (!plugin) throw notFound("PLUGIN_NOT_FOUND", `Plugin not found: ${pluginId}`);
	return plugin;
}

async function requireAvailableVersion(
	runtime: MarketplaceHttpRuntime,
	pluginId: string,
	version: string,
): Promise<StoredPluginVersion> {
	const found = await runtime.store.getPublicVersion(pluginId, version);
	if (!found) throw notFound("PLUGIN_VERSION_NOT_FOUND", `Plugin version not found: ${pluginId}@${version}`);
	return found;
}
