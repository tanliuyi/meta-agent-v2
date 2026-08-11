import { createHash } from "node:crypto";
import { Body, Headers, Param, Req, type Type } from "@nestjs/common";
import { valid as validSemver } from "semver";
import { buildArtifact, extractPayloadArchive, validatePayloadPath } from "../artifact-builder.ts";
import { ARTIFACT_ID, PLUGIN_ID, parseTarget } from "../catalog-validation.ts";
import { parsePluginConfigurationSchema } from "../configuration-schema.ts";
import type {
	MarketplacePluginVersionDetail,
	PublishPluginRequest,
	PublishPluginState,
	PublishVersionArtifactRequest,
	PublishVersionRequest,
	PublishVersionState,
} from "../contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import { versionDetail } from "./http-mapping.ts";
import {
	badRequest,
	bodyArray,
	bodyBoolean,
	bodyInteger,
	bodyObject,
	bodyOptionalString,
	bodyString,
	bodyStringArray,
	forbidden,
	type MarketplaceHttpRuntime,
	mapStoreErrors,
	mapStoreErrorsAsync,
	notFound,
	type RawUploadRequest,
	readPluginIconBody,
	readUploadBody,
	requirePrincipal,
} from "./http-util.ts";

export interface ArtifactUploadResponse {
	pluginId: string;
	version: string;
	artifactId: string;
	sha256: string;
	size: number;
}

export interface PluginIconUploadResponse {
	pluginId: string;
	iconAssetId: string;
	contentType: string;
	sha256: string;
	size: number;
}

export function createPublishControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	class PublishController {
		async list(authorization: string | undefined): Promise<{ plugins: PublishPluginState[] }> {
			const principal = await requirePrincipal(runtime, authorization);
			const publisherIds =
				principal.kind === "admin" ? undefined : await runtime.store.publisherIdsForUser(principal.userId);
			const plugins = await runtime.store.listPublishStates(publisherIds);
			return { plugins };
		}

		async state(pluginId: string, authorization: string | undefined): Promise<{ plugin: PublishPluginState }> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			const plugin = await mapStoreErrorsAsync(() => runtime.store.publishState(pluginId));
			return { plugin };
		}

		async upsertPlugin(
			pluginId: string,
			body: unknown,
			authorization: string | undefined,
		): Promise<{ plugin: PublishPluginState }> {
			validatePluginId(pluginId);
			const request = parsePublishPluginRequest(body);
			const principal = await requirePrincipal(runtime, authorization);
			if (
				principal.kind === "user" &&
				!(await runtime.store.isPublisherMember(principal.userId, request.publisherId))
			) {
				throw forbidden("PUBLISHER_MEMBERSHIP_REQUIRED", "You are not a member of this publisher");
			}
			const plugin = await mapStoreErrorsAsync(() => runtime.store.upsertPlugin(pluginId, request));
			return { plugin };
		}

		async uploadIcon(
			pluginId: string,
			authorization: string | undefined,
			request: RawUploadRequest,
		): Promise<PluginIconUploadResponse> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			const uploaded = await readPluginIconBody(request);
			const sha256 = createHash("sha256").update(uploaded.bytes).digest("hex");
			const icon = await mapStoreErrorsAsync(() =>
				runtime.store.putPluginIcon(pluginId, {
					contentType: uploaded.contentType,
					bytes: uploaded.bytes,
					sha256,
					size: uploaded.bytes.byteLength,
				}),
			);
			return {
				pluginId,
				iconAssetId: icon.assetId,
				contentType: icon.contentType,
				sha256: icon.sha256,
				size: icon.size,
			};
		}

		async createVersion(
			pluginId: string,
			body: unknown,
			authorization: string | undefined,
		): Promise<{ pluginId: string; version: PublishVersionState }> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			const request = parsePublishVersionRequest(body);
			const version = await mapStoreErrorsAsync(() => runtime.store.createDraftVersion(pluginId, request));
			return { pluginId, version };
		}

		async uploadArtifact(
			pluginId: string,
			version: string,
			artifactId: string,
			authorization: string | undefined,
			request: RawUploadRequest,
		): Promise<ArtifactUploadResponse> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			const context = await mapStoreErrorsAsync(() => runtime.store.getUploadContext(pluginId, version, artifactId));
			const bytes = await readUploadBody(request, runtime.config.maxArtifactBytes);
			const built = mapStoreErrors(() => {
				const files = extractPayloadArchive(bytes, 4 * runtime.config.maxArtifactBytes);
				return buildArtifact({
					marketplaceId: runtime.config.marketplaceId,
					artifactId: context.artifact.id,
					plugin: {
						id: pluginId,
						name: context.pluginName,
						version,
						publisherId: context.publisherId,
					},
					entry: context.artifact.entry,
					desktop: context.desktop,
					target: context.artifact.target,
					configuration: context.configuration,
					capabilities: context.capabilities,
					files,
				});
			});
			await mapStoreErrorsAsync(() =>
				runtime.store.putArtifactContent(pluginId, version, artifactId, {
					bytes: built.bytes,
					sha256: built.sha256,
					size: built.size,
				}),
			);
			return { pluginId, version, artifactId, sha256: built.sha256, size: built.size };
		}

		async publish(
			pluginId: string,
			version: string,
			authorization: string | undefined,
		): Promise<{ pluginId: string; version: MarketplacePluginVersionDetail }> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			await mapStoreErrorsAsync(() =>
				runtime.store.publishVersion(pluginId, version, (artifact) => {
					if (artifact.containsNativeCode) throw new Error("PAYLOAD_NATIVE_UNSUPPORTED");
					if (artifact.bytes) extractPayloadArchive(artifact.bytes, 5 * runtime.config.maxArtifactBytes);
				}),
			);
			const published = await runtime.store.getPublicVersion(pluginId, version);
			if (!published) throw notFound("PLUGIN_VERSION_NOT_FOUND", `Plugin version not found: ${pluginId}@${version}`);
			return { pluginId, version: versionDetail(pluginId, published, runtime.config.publicBaseUrl) };
		}

		async deprecate(
			pluginId: string,
			version: string,
			authorization: string | undefined,
		): Promise<{ pluginId: string; version: string; status: "deprecated" }> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			await mapStoreErrorsAsync(() => runtime.store.deprecateVersion(pluginId, version));
			return { pluginId, version, status: "deprecated" };
		}

		async deleteDraft(pluginId: string, version: string, authorization: string | undefined): Promise<void> {
			validatePluginId(pluginId);
			await requirePluginMember(runtime, authorization, pluginId);
			await mapStoreErrorsAsync(() => runtime.store.deleteDraftVersion(pluginId, version));
		}
	}

	applyController(PublishController, "v1/publish/plugins");
	applyRoute(PublishController.prototype, "list", "get", "");
	applyParameter(PublishController.prototype, "list", 0, Headers("authorization"));
	applyRoute(PublishController.prototype, "state", "get", ":pluginId");
	applyParameter(PublishController.prototype, "state", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "state", 1, Headers("authorization"));
	applyRoute(PublishController.prototype, "upsertPlugin", "put", ":pluginId");
	applyParameter(PublishController.prototype, "upsertPlugin", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "upsertPlugin", 1, Body());
	applyParameter(PublishController.prototype, "upsertPlugin", 2, Headers("authorization"));
	applyRoute(PublishController.prototype, "uploadIcon", "put", ":pluginId/icon");
	applyParameter(PublishController.prototype, "uploadIcon", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "uploadIcon", 1, Headers("authorization"));
	applyParameter(PublishController.prototype, "uploadIcon", 2, Req());
	applyRoute(PublishController.prototype, "createVersion", "post", ":pluginId/versions");
	applyParameter(PublishController.prototype, "createVersion", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "createVersion", 1, Body());
	applyParameter(PublishController.prototype, "createVersion", 2, Headers("authorization"));
	applyRoute(
		PublishController.prototype,
		"uploadArtifact",
		"put",
		":pluginId/versions/:version/artifacts/:artifactId",
	);
	applyParameter(PublishController.prototype, "uploadArtifact", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "uploadArtifact", 1, Param("version"));
	applyParameter(PublishController.prototype, "uploadArtifact", 2, Param("artifactId"));
	applyParameter(PublishController.prototype, "uploadArtifact", 3, Headers("authorization"));
	applyParameter(PublishController.prototype, "uploadArtifact", 4, Req());
	applyRoute(PublishController.prototype, "publish", "post", ":pluginId/versions/:version/publish");
	applyHttpCode(PublishController.prototype, "publish", 200);
	applyParameter(PublishController.prototype, "publish", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "publish", 1, Param("version"));
	applyParameter(PublishController.prototype, "publish", 2, Headers("authorization"));
	applyRoute(PublishController.prototype, "deprecate", "post", ":pluginId/versions/:version/deprecate");
	applyHttpCode(PublishController.prototype, "deprecate", 200);
	applyParameter(PublishController.prototype, "deprecate", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "deprecate", 1, Param("version"));
	applyParameter(PublishController.prototype, "deprecate", 2, Headers("authorization"));
	applyRoute(PublishController.prototype, "deleteDraft", "delete", ":pluginId/versions/:version");
	applyHttpCode(PublishController.prototype, "deleteDraft", 204);
	applyParameter(PublishController.prototype, "deleteDraft", 0, Param("pluginId"));
	applyParameter(PublishController.prototype, "deleteDraft", 1, Param("version"));
	applyParameter(PublishController.prototype, "deleteDraft", 2, Headers("authorization"));

	return [PublishController];
}

async function requirePluginMember(
	runtime: MarketplaceHttpRuntime,
	authorization: string | undefined,
	pluginId: string,
): Promise<void> {
	const principal = await requirePrincipal(runtime, authorization);
	if (principal.kind === "admin") return;
	const publisherId = await runtime.store.getPluginPublisherId(pluginId);
	if (publisherId === undefined) throw notFound("PLUGIN_NOT_FOUND", `Plugin not found: ${pluginId}`);
	const isMember = await runtime.store.isPublisherMember(principal.userId, publisherId);
	if (!isMember) {
		throw forbidden("PUBLISHER_MEMBERSHIP_REQUIRED", "You are not a member of this plugin's publisher");
	}
}

function validatePluginId(pluginId: string): void {
	if (pluginId.length > 200 || !PLUGIN_ID.test(pluginId)) {
		throw badRequest("PLUGIN_ID_INVALID", "Plugin ID must be a lowercase dotted identifier");
	}
}

function parsePublishPluginRequest(body: unknown): PublishPluginRequest {
	const record = bodyObject(body);
	const publisherId = bodyString(record, "publisherId", 64);
	const iconAssetId = bodyOptionalString(record, "iconAssetId", 128);
	return {
		name: bodyString(record, "name", 120),
		description: bodyString(record, "description", 2000),
		publisherId,
		categories: bodyStringArray(record, "categories", 8, 40),
		...(iconAssetId === undefined ? {} : { iconAssetId }),
	};
}

function parsePublishVersionRequest(body: unknown): PublishVersionRequest {
	const record = bodyObject(body);
	const version = bodyString(record, "version", 64);
	if (!validSemver(version)) throw badRequest("BODY_INVALID", "version must be semver");
	const desktopRecord = bodyObject(record.desktop);
	const minVersion = bodyOptionalString(desktopRecord, "minVersion", 64);
	const maxVersionExclusive = bodyOptionalString(desktopRecord, "maxVersionExclusive", 64);
	for (const [key, value] of [
		["desktop.minVersion", minVersion],
		["desktop.maxVersionExclusive", maxVersionExclusive],
	] as const) {
		if (value !== undefined && !validSemver(value)) throw badRequest("BODY_INVALID", `${key} must be semver`);
	}
	const artifacts = bodyArray(record, "artifacts", 16).map((entry, index) =>
		parsePublishArtifact(entry, `artifacts[${index}]`),
	);
	if (new Set(artifacts.map(({ id }) => id)).size !== artifacts.length) {
		throw badRequest("BODY_INVALID", "artifacts must have unique ids");
	}
	if (artifacts.filter(({ preferred }) => preferred).length !== 1) {
		throw badRequest(
			"BODY_INVALID",
			"artifacts must include exactly one preferred entry (the Desktop client requires a unique preferred artifact per runtime)",
		);
	}
	let configuration: PublishVersionRequest["configuration"];
	try {
		configuration = parsePluginConfigurationSchema(record.configuration);
	} catch (error) {
		throw badRequest("BODY_INVALID", error instanceof Error ? error.message : "configuration is invalid");
	}
	const capabilities = bodyStringArray(record, "capabilities", 32, 64);
	if (configuration && !capabilities.includes("configuration.read")) {
		throw badRequest("BODY_INVALID", "configuration requires the configuration.read capability");
	}
	return {
		version,
		changelog: bodyString(record, "changelog", 4000),
		desktop: {
			hostProfileVersion: bodyInteger(desktopRecord, "hostProfileVersion", 1, 1000),
			...(minVersion === undefined ? {} : { minVersion }),
			...(maxVersionExclusive === undefined ? {} : { maxVersionExclusive }),
		},
		...(configuration ? { configuration } : {}),
		capabilities,
		artifacts,
	};
}

function parsePublishArtifact(value: unknown, path: string): PublishVersionArtifactRequest {
	const record = bodyObject(value);
	const id = bodyString(record, "id", 128);
	if (!ARTIFACT_ID.test(id)) throw badRequest("BODY_INVALID", `${path}.id is not a valid artifact identifier`);
	const entry = bodyString(record, "entry", 256);
	try {
		validatePayloadPath(entry);
	} catch {
		throw badRequest("BODY_INVALID", `${path}.entry must be a safe payload-relative file path`);
	}
	let target: PublishVersionArtifactRequest["target"];
	try {
		target = parseTarget(record.target, `${path}.target`);
	} catch (error) {
		throw badRequest("BODY_INVALID", error instanceof Error ? error.message : `${path}.target is invalid`);
	}
	const containsNativeCode = bodyBoolean(record, "containsNativeCode");
	if (containsNativeCode) {
		throw badRequest(
			"NATIVE_ARTIFACT_UNSUPPORTED",
			`${path}.containsNativeCode cannot be enabled until native metadata is supported`,
		);
	}
	return {
		id,
		target,
		entry,
		containsNativeCode,
		preferred: bodyBoolean(record, "preferred"),
	};
}
