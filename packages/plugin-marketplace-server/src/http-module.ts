import {
	BadRequestException,
	Controller,
	type DynamicModule,
	Get,
	GoneException,
	Module,
	NotFoundException,
	Param,
	Req,
	Res,
	type Type,
} from "@nestjs/common";
import { rcompare } from "semver";
import type { GeneratedMarketplaceArtifact, MarketplaceArtifactService } from "./artifact-service.ts";
import type { CatalogRepository } from "./catalog-repository.ts";
import type { MarketplaceServerConfig } from "./config.ts";
import type {
	CatalogArtifact,
	CatalogPlugin,
	CatalogPluginVersion,
	MarketplaceArtifactMetadata,
	MarketplaceErrorBody,
	MarketplacePluginDetail,
	MarketplacePluginVersionDetail,
	MarketplaceRevocationData,
	MarketplaceRuntimeQuery,
	WellKnownMarketplaceData,
} from "./contracts.ts";
import type { MarketplaceSigningService } from "./signing-service.ts";

interface RequestLike {
	query: Record<string, unknown>;
}

interface ResponseLike {
	setHeader(name: string, value: string | number): void;
	send(body: Uint8Array): unknown;
}

export interface MarketplaceHttpRuntime {
	config: MarketplaceServerConfig;
	repository: CatalogRepository;
	signing: MarketplaceSigningService;
	artifacts: MarketplaceArtifactService;
	clock(): number;
}

export function createMarketplaceHttpModule(runtime: MarketplaceHttpRuntime): DynamicModule {
	class HealthController {
		health(): Record<string, string | boolean> {
			return {
				status: "ok",
				marketplaceId: runtime.config.marketplaceId,
				ephemeralSigningKey: runtime.config.ephemeralSigningKey,
			};
		}
	}

	class DiscoveryController {
		discovery() {
			const data: WellKnownMarketplaceData = {
				protocolVersion: 1,
				marketplaceId: runtime.config.marketplaceId,
				apiRoot: `${runtime.config.publicBaseUrl}/v1`,
				artifactOrigins: effectiveArtifactOrigins(runtime.config),
				signing: {
					algorithm: "ed25519",
					keyId: runtime.signing.keyId,
					fingerprint: runtime.signing.fingerprint,
					publicKey: runtime.signing.publicKey,
				},
			};
			return runtime.signing.envelope(data);
		}
	}

	class PluginsController {
		list(request: RequestLike) {
			const query = request.query;
			const limit = parseLimit(query.limit);
			const runtimeQuery = parseRuntimeQuery(query);
			try {
				return runtime.repository.list({
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

		detail(pluginId: string): MarketplacePluginDetail {
			return pluginDetail(
				requirePlugin(runtime.repository, pluginId),
				runtime.config.publicBaseUrl,
				runtime.artifacts,
			);
		}

		versions(pluginId: string): MarketplacePluginVersionDetail[] {
			return requirePlugin(runtime.repository, pluginId).versions.map((version) =>
				versionDetail(pluginId, version, runtime.config.publicBaseUrl, runtime.artifacts),
			);
		}

		version(pluginId: string, version: string): MarketplacePluginVersionDetail {
			const found = runtime.repository.getVersion(pluginId, version);
			if (!found) throw notFound("PLUGIN_VERSION_NOT_FOUND", `Plugin version not found: ${pluginId}@${version}`);
			return versionDetail(pluginId, found, runtime.config.publicBaseUrl, runtime.artifacts);
		}

		artifacts(pluginId: string, version: string): { artifacts: MarketplaceArtifactMetadata[] } {
			const found = requireArtifactVersion(runtime.repository, pluginId, version);
			return {
				artifacts: found.artifacts.map((artifact) =>
					artifactMetadata(pluginId, version, artifact, runtime.config.publicBaseUrl, runtime.artifacts),
				),
			};
		}

		download(pluginId: string, version: string, artifactId: string) {
			requireArtifactVersion(runtime.repository, pluginId, version);
			const artifact = runtime.artifacts.get(pluginId, version, artifactId);
			if (!artifact) {
				throw notFound("PLUGIN_ARTIFACT_NOT_FOUND", `Plugin artifact not found: ${artifactId}`);
			}
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
		bytes(pluginId: string, version: string, artifactId: string, response: ResponseLike): unknown {
			requireArtifactVersion(runtime.repository, pluginId, version);
			const artifact = runtime.artifacts.get(pluginId, version, artifactId);
			if (!artifact) {
				throw notFound("PLUGIN_ARTIFACT_NOT_FOUND", `Plugin artifact not found: ${artifactId}`);
			}
			response.setHeader("content-type", "application/vnd.meta-agent.plugin+zip");
			response.setHeader("content-length", artifact.size);
			response.setHeader("content-disposition", 'attachment; filename="plugin.meta-plugin"');
			response.setHeader("cache-control", "public, max-age=31536000, immutable");
			response.setHeader("etag", `"sha256-${artifact.sha256}"`);
			return response.send(artifact.bytes);
		}
	}

	let lastRevocationSequence = -1;
	class RevocationsController {
		revocations() {
			const issuedAt = Math.trunc(runtime.clock());
			if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("Marketplace clock is invalid");
			const sequence = Math.max(issuedAt, lastRevocationSequence + 1);
			lastRevocationSequence = sequence;
			const data: MarketplaceRevocationData = {
				marketplaceId: runtime.config.marketplaceId,
				sequence,
				issuedAt,
				nextUpdateAt: issuedAt + 4 * 60 * 60 * 1000,
				revokedKeys: [],
				pluginVersions: runtime.repository.getRevocations(),
			};
			return runtime.signing.envelope(data);
		}
	}

	applyController(HealthController, "");
	applyGet(HealthController.prototype, "health", "health");

	applyController(DiscoveryController, "");
	applyGet(DiscoveryController.prototype, "discovery", ".well-known/meta-agent-marketplace.json");

	applyController(PluginsController, "v1/plugins");
	applyGet(PluginsController.prototype, "list", "");
	applyParameter(PluginsController.prototype, "list", 0, Req());
	applyGet(PluginsController.prototype, "detail", ":pluginId");
	applyParameter(PluginsController.prototype, "detail", 0, Param("pluginId"));
	applyGet(PluginsController.prototype, "versions", ":pluginId/versions");
	applyParameter(PluginsController.prototype, "versions", 0, Param("pluginId"));
	applyGet(PluginsController.prototype, "version", ":pluginId/versions/:version");
	applyParameter(PluginsController.prototype, "version", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "version", 1, Param("version"));
	applyGet(PluginsController.prototype, "artifacts", ":pluginId/versions/:version/artifacts");
	applyParameter(PluginsController.prototype, "artifacts", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "artifacts", 1, Param("version"));
	applyGet(PluginsController.prototype, "download", ":pluginId/versions/:version/artifacts/:artifactId/download");
	applyParameter(PluginsController.prototype, "download", 0, Param("pluginId"));
	applyParameter(PluginsController.prototype, "download", 1, Param("version"));
	applyParameter(PluginsController.prototype, "download", 2, Param("artifactId"));

	applyController(ArtifactsController, "v1/artifacts");
	applyGet(ArtifactsController.prototype, "bytes", ":pluginId/:version/:artifactId");
	applyParameter(ArtifactsController.prototype, "bytes", 0, Param("pluginId"));
	applyParameter(ArtifactsController.prototype, "bytes", 1, Param("version"));
	applyParameter(ArtifactsController.prototype, "bytes", 2, Param("artifactId"));
	applyParameter(ArtifactsController.prototype, "bytes", 3, Res());

	applyController(RevocationsController, "v1");
	applyGet(RevocationsController.prototype, "revocations", "revocations");

	class MarketplaceModule {}
	Module({
		controllers: [
			HealthController,
			DiscoveryController,
			PluginsController,
			ArtifactsController,
			RevocationsController,
		],
	})(MarketplaceModule);

	return { module: MarketplaceModule as Type<unknown> };
}

function pluginDetail(
	plugin: CatalogPlugin,
	publicBaseUrl: string,
	artifacts: MarketplaceArtifactService,
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
		versions: plugin.versions.map((version) => versionDetail(plugin.id, version, publicBaseUrl, artifacts)),
	};
}

function versionDetail(
	pluginId: string,
	version: CatalogPluginVersion,
	publicBaseUrl: string,
	artifacts: MarketplaceArtifactService,
): MarketplacePluginVersionDetail {
	return {
		version: version.version,
		status: version.status,
		changelog: version.changelog,
		publishedAt: version.publishedAt,
		desktop: { ...version.desktop },
		capabilities: [...version.capabilities],
		artifacts: version.artifacts.map((artifact) =>
			artifactMetadata(pluginId, version.version, artifact, publicBaseUrl, artifacts),
		),
	};
}

function artifactMetadata(
	pluginId: string,
	version: string,
	artifact: CatalogArtifact,
	publicBaseUrl: string,
	artifacts: MarketplaceArtifactService,
): MarketplaceArtifactMetadata {
	const generated = requireGeneratedArtifact(artifacts, pluginId, version, artifact.id);
	return {
		id: artifact.id,
		target: { ...artifact.target },
		sha256: generated.sha256,
		size: generated.size,
		containsNativeCode: artifact.containsNativeCode,
		preferred: artifact.preferred,
		downloadEndpoint: `${publicBaseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
	};
}

function requireGeneratedArtifact(
	artifacts: MarketplaceArtifactService,
	pluginId: string,
	version: string,
	artifactId: string,
): GeneratedMarketplaceArtifact {
	const generated = artifacts.get(pluginId, version, artifactId);
	if (!generated) throw new Error(`Catalog artifact generation failed: ${pluginId}@${version}/${artifactId}`);
	return generated;
}

function artifactUrl(publicBaseUrl: string, pluginId: string, version: string, artifactId: string): URL {
	return new URL(
		`${publicBaseUrl}/v1/artifacts/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/${encodeURIComponent(artifactId)}`,
	);
}

function effectiveArtifactOrigins(config: MarketplaceServerConfig): string[] {
	return [...new Set([new URL(config.publicBaseUrl).origin, ...config.artifactOrigins])];
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
			? { runtimeCompatibilityId: optionalQueryString(query.runtimeCompatibilityId, "runtimeCompatibilityId") }
			: {}),
		includeIncompatible: parseBoolean(query.includeIncompatible, "includeIncompatible", false),
	};
}

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

function requirePlugin(repository: CatalogRepository, pluginId: string): CatalogPlugin {
	const plugin = repository.getPlugin(pluginId);
	if (!plugin) throw notFound("PLUGIN_NOT_FOUND", `Plugin not found: ${pluginId}`);
	return plugin;
}

function requireArtifactVersion(
	repository: CatalogRepository,
	pluginId: string,
	version: string,
): CatalogPluginVersion {
	const found = repository.getVersion(pluginId, version);
	if (!found) throw notFound("PLUGIN_VERSION_NOT_FOUND", `Plugin version not found: ${pluginId}@${version}`);
	if (found.status === "withdrawn" || found.status === "blocked") {
		throw new GoneException(
			errorBody("PLUGIN_VERSION_UNAVAILABLE", `Plugin version is ${found.status}: ${pluginId}@${version}`),
		);
	}
	return found;
}

function badRequest(code: string, message: string): BadRequestException {
	return new BadRequestException(errorBody(code, message));
}

function notFound(code: string, message: string): NotFoundException {
	return new NotFoundException(errorBody(code, message));
}

function errorBody(code: string, message: string): MarketplaceErrorBody {
	return { error: { code, message } };
}

function applyController(target: Type<unknown>, path: string): void {
	Controller(path)(target);
}

function applyGet(target: object, key: string, path: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	if (!descriptor) throw new Error(`Missing route method: ${key}`);
	Get(path)(target, key, descriptor);
}

function applyParameter(target: object, key: string, index: number, decorator: ParameterDecorator): void {
	decorator(target, key, index);
}
