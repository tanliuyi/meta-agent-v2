import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Pool, QueryResult } from "pg";
import { compare as compareSemver } from "semver";
import type { ListPluginsInput, PluginAggregates } from "../catalog-query.ts";
import { listPluginPage } from "../catalog-query.ts";
import type {
	ArtifactContent,
	ArtifactContentInput,
	ArtifactTarget,
	ArtifactUploadContext,
	MarketplacePluginPage,
	PluginIconContent,
	PluginIconContentInput,
	PluginStatus,
	PublishArtifactAuditContent,
	PublishPluginRequest,
	PublishPluginState,
	PublishVersionRequest,
	PublishVersionState,
	StoredArtifact,
	StoredPlugin,
	StoredPluginVersion,
} from "../contracts.ts";
import type { QueryRunner } from "./query-runner.ts";
import { isUniqueViolation } from "./query-runner.ts";

interface PluginRow {
	id: string;
	name: string;
	description: string;
	publisher_id: string;
	publisher_display_name: string;
	publisher_verified: boolean;
	categories: string;
	icon_asset_id: string | null;
	published_at: number;
	updated_at: number;
}

interface VersionRow {
	plugin_id: string;
	version: string;
	status: string;
	draft: boolean;
	changelog: string;
	published_at: number;
	desktop: string;
	configuration: string | null;
	capabilities: string;
}

interface ArtifactRow {
	version: string;
	artifact_id: string;
	target: string;
	contains_native_code: boolean;
	preferred: boolean;
	entry: string;
	sha256: string | null;
	size: number | null;
	uploaded: boolean;
}

export interface RatingAggregate {
	count: number;
	average: number | null;
}

export class PluginStore {
	private readonly pool: Pool;
	private readonly artifactDirectory: string | undefined;

	constructor(pool: Pool, artifactDirectory?: string) {
		this.pool = pool;
		this.artifactDirectory = artifactDirectory;
	}

	// --- public catalog reads ---

	async list(
		input: ListPluginsInput,
		ratings: Map<string, RatingAggregate>,
		downloads: Map<string, number>,
	): Promise<MarketplacePluginPage> {
		const plugins = await this.loadPlugins(undefined, false);
		const aggregates = (pluginId: string): PluginAggregates => ({
			rating: ratings.get(pluginId) ?? { count: 0, average: null },
			downloadCount: downloads.get(pluginId) ?? 0,
		});
		return listPluginPage(plugins, input, aggregates);
	}

	async getPublicPlugin(pluginId: string): Promise<StoredPlugin | undefined> {
		const plugins = await this.loadPlugins(pluginId, false);
		return plugins[0];
	}

	async getPublicVersion(pluginId: string, version: string): Promise<StoredPluginVersion | undefined> {
		const plugin = await this.getPublicPlugin(pluginId);
		return plugin?.versions.find((entry) => entry.version === version);
	}

	async hasPublicPlugin(pluginId: string): Promise<boolean> {
		return (await this.getPublicPlugin(pluginId)) !== undefined;
	}

	async getArtifactContent(
		pluginId: string,
		version: string,
		artifactId: string,
	): Promise<ArtifactContent | undefined> {
		const result = await this.pool.query(
			"SELECT a.bytes AS bytes, a.object_key AS object_key, a.sha256 AS sha256, a.size AS size FROM plugin_artifacts a JOIN plugin_versions v ON v.plugin_id = a.plugin_id AND v.version = a.version WHERE a.plugin_id = $1 AND a.version = $2 AND a.artifact_id = $3 AND v.draft = $4 AND (a.bytes IS NOT NULL OR a.object_key IS NOT NULL)",
			[pluginId, version, artifactId, false],
		);
		const row = result.rows[0] as
			| { bytes: Buffer | null; object_key: string | null; sha256: string; size: number }
			| undefined;
		if (!row) return undefined;
		if (row.bytes) return { bytes: row.bytes, sha256: row.sha256, size: row.size };
		if (!row.object_key || !this.artifactDirectory) return undefined;
		const bytes = await readArtifactFile(this.artifactDirectory, row.object_key);
		if (!bytes) return undefined;
		if (bytes.byteLength !== row.size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
			throw new Error("Stored artifact content does not match its PostgreSQL metadata");
		}
		return { bytes, sha256: row.sha256, size: row.size };
	}

	async getPluginIcon(pluginId: string): Promise<PluginIconContent | undefined> {
		const result = await this.pool.query(
			"SELECT asset_id, content_type, bytes, object_key, sha256, size FROM plugin_icons WHERE plugin_id = $1",
			[pluginId],
		);
		const row = result.rows[0] as
			| {
					asset_id: string;
					content_type: string;
					bytes: Buffer | null;
					object_key: string | null;
					sha256: string;
					size: number;
			  }
			| undefined;
		if (!row) return undefined;
		const storedBytes =
			row.bytes ??
			(row.object_key && this.artifactDirectory
				? await readArtifactFile(this.artifactDirectory, row.object_key)
				: undefined);
		if (!storedBytes) return undefined;
		const bytes = Buffer.from(storedBytes);
		const size = Number(row.size);
		if (bytes.byteLength !== size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
			throw new Error("Stored plugin icon content does not match its PostgreSQL metadata");
		}
		return {
			assetId: row.asset_id,
			contentType: row.content_type,
			bytes,
			sha256: row.sha256,
			size,
		};
	}

	async putPluginIcon(pluginId: string, content: PluginIconContentInput, now: number): Promise<PluginIconContent> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const plugin = await client.query("SELECT 1 FROM plugins WHERE id = $1", [pluginId]);
			if (plugin.rowCount === 0) throw new Error("PLUGIN_NOT_FOUND");
			const assetId = content.sha256;
			await client.query(
				`INSERT INTO plugin_icons (plugin_id, asset_id, content_type, sha256, size, bytes, object_key, updated_at)
				 VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), NULL, $7)
				 ON CONFLICT (plugin_id) DO UPDATE SET
				   asset_id = EXCLUDED.asset_id,
				   content_type = EXCLUDED.content_type,
				   sha256 = EXCLUDED.sha256,
				   size = EXCLUDED.size,
				   bytes = EXCLUDED.bytes,
				   object_key = EXCLUDED.object_key,
				   updated_at = EXCLUDED.updated_at`,
				[
					pluginId,
					assetId,
					content.contentType,
					content.sha256,
					content.size,
					Buffer.from(content.bytes).toString("hex"),
					now,
				],
			);
			await client.query("UPDATE plugins SET icon_asset_id = $1, updated_at = $2 WHERE id = $3", [
				assetId,
				now,
				pluginId,
			]);
			await client.query("COMMIT");
			return { assetId, ...content };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	// --- publishing ---

	async getPluginPublisherId(pluginId: string): Promise<string | undefined> {
		const result = await this.pool.query("SELECT publisher_id FROM plugins WHERE id = $1", [pluginId]);
		const row = result.rows[0] as { publisher_id: string } | undefined;
		return row?.publisher_id;
	}

	async upsertPlugin(pluginId: string, request: PublishPluginRequest, now: number): Promise<PublishPluginState> {
		const result = await this.pool.query(
			`INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
			 ON CONFLICT (id) DO UPDATE SET
			   name = EXCLUDED.name,
			   description = EXCLUDED.description,
			   categories = EXCLUDED.categories,
			   icon_asset_id = COALESCE(EXCLUDED.icon_asset_id, plugins.icon_asset_id),
			   updated_at = EXCLUDED.updated_at
			 WHERE plugins.publisher_id = EXCLUDED.publisher_id
			 RETURNING publisher_id`,
			[
				pluginId,
				request.name,
				request.description,
				request.publisherId,
				JSON.stringify(request.categories),
				request.iconAssetId ?? null,
				now,
			],
		);
		if (result.rowCount === 0) throw new Error("PLUGIN_PUBLISHER_MISMATCH");
		return this.publishState(pluginId);
	}

	async createDraftVersion(pluginId: string, request: PublishVersionRequest): Promise<PublishVersionState> {
		if ((await this.getPluginPublisherId(pluginId)) === undefined) throw new Error("PLUGIN_NOT_FOUND");

		const check = await this.pool.query(
			"SELECT 1 AS found FROM plugin_versions WHERE plugin_id = $1 AND version = $2",
			[pluginId, request.version],
		);
		if (check.rows.length > 0) throw new Error("PLUGIN_VERSION_EXISTS");

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			await client.query(
				"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities) VALUES ($1, $2, 'available', $3, $4, $5, $6, $7, $8)",
				[
					pluginId,
					request.version,
					true,
					request.changelog,
					0,
					JSON.stringify(request.desktop),
					request.configuration ? JSON.stringify(request.configuration) : null,
					JSON.stringify(request.capabilities),
				],
			);

			for (const artifact of request.artifacts) {
				await client.query(
					"INSERT INTO plugin_artifacts (plugin_id, version, artifact_id, target, contains_native_code, preferred, entry) VALUES ($1, $2, $3, $4, $5, $6, $7)",
					[
						pluginId,
						request.version,
						artifact.id,
						JSON.stringify(artifact.target),
						artifact.containsNativeCode,
						artifact.preferred,
						artifact.entry,
					],
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			if (isUniqueViolation(error)) throw new Error("PLUGIN_VERSION_EXISTS");
			throw error;
		} finally {
			client.release();
		}

		return (await this.versionState(pluginId, request.version))!;
	}

	async getUploadContext(pluginId: string, version: string, artifactId: string): Promise<ArtifactUploadContext> {
		const versionRow = await this.requireVersionRow(this.pool, pluginId, version);
		if (versionRow.draft !== true) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const result = await this.pool.query(
			"SELECT target, entry FROM plugin_artifacts WHERE plugin_id = $1 AND version = $2 AND artifact_id = $3",
			[pluginId, version, artifactId],
		);
		const artifactRow = result.rows[0] as { target: string; entry: string } | undefined;
		if (!artifactRow) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");

		const pluginResult = await this.pool.query("SELECT name, publisher_id FROM plugins WHERE id = $1", [pluginId]);
		const pluginRow = pluginResult.rows[0] as { name: string; publisher_id: string } | undefined;
		if (!pluginRow) throw new Error("PLUGIN_NOT_FOUND");

		return {
			pluginName: pluginRow.name,
			publisherId: pluginRow.publisher_id,
			desktop: JSON.parse(versionRow.desktop) as StoredPluginVersion["desktop"],
			...(versionRow.configuration
				? { configuration: JSON.parse(versionRow.configuration) as StoredPluginVersion["configuration"] }
				: {}),
			capabilities: JSON.parse(versionRow.capabilities) as string[],
			artifact: {
				id: artifactId,
				target: JSON.parse(artifactRow.target) as ArtifactTarget,
				entry: artifactRow.entry,
			},
		};
	}

	async putArtifactContent(
		pluginId: string,
		version: string,
		artifactId: string,
		content: ArtifactContentInput,
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const versionRow = await this.requireVersionRow(client, pluginId, version, true);
			if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
			const result = await client.query(
				"UPDATE plugin_artifacts SET sha256 = $1, size = $2, bytes = decode($3, 'hex') WHERE plugin_id = $4 AND version = $5 AND artifact_id = $6",
				[content.sha256, content.size, Buffer.from(content.bytes).toString("hex"), pluginId, version, artifactId],
			);
			if (result.rowCount === 0) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async publishVersion(
		pluginId: string,
		version: string,
		now: number,
		validateArtifact: (artifact: PublishArtifactAuditContent) => void,
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const versionRow = await this.requireVersionRow(client, pluginId, version, true);
			if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
			const result = await client.query(
				"SELECT artifact_id, contains_native_code, bytes FROM plugin_artifacts WHERE plugin_id = $1 AND version = $2 ORDER BY artifact_id",
				[pluginId, version],
			);
			const artifacts = result.rows as Array<{
				artifact_id: string;
				contains_native_code: boolean;
				bytes: Buffer | null;
			}>;
			if (artifacts.some((artifact) => artifact.bytes === null)) throw new Error("PLUGIN_VERSION_INCOMPLETE");
			for (const artifact of artifacts) {
				validateArtifact({
					artifactId: artifact.artifact_id,
					containsNativeCode: artifact.contains_native_code,
					...(artifact.bytes ? { bytes: new Uint8Array(artifact.bytes) } : {}),
				});
			}
			await client.query(
				"UPDATE plugin_versions SET draft = FALSE, published_at = $1 WHERE plugin_id = $2 AND version = $3",
				[now, pluginId, version],
			);
			await client.query("UPDATE plugins SET updated_at = $1 WHERE id = $2", [now, pluginId]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async deleteDraftVersion(pluginId: string, version: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const versionRow = await this.requireVersionRow(client, pluginId, version, true);
			if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
			await client.query("DELETE FROM plugin_versions WHERE plugin_id = $1 AND version = $2", [pluginId, version]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async deprecateVersion(pluginId: string, version: string, now: number): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const versionRow = await this.requireVersionRow(client, pluginId, version, true);
			if (versionRow.draft || versionRow.status !== "available") {
				throw new Error("PLUGIN_VERSION_STATUS_INVALID");
			}
			await client.query("UPDATE plugin_versions SET status = 'deprecated' WHERE plugin_id = $1 AND version = $2", [
				pluginId,
				version,
			]);
			await client.query("UPDATE plugins SET updated_at = $1 WHERE id = $2", [now, pluginId]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async listPublishStates(publisherIds?: readonly string[]): Promise<PublishPluginState[]> {
		const allowedPublisherIds = publisherIds ? new Set(publisherIds) : undefined;
		const plugins = await this.loadPlugins(undefined, true);
		const filtered = plugins.filter((plugin) => !allowedPublisherIds || allowedPublisherIds.has(plugin.publisher.id));
		return filtered.map((plugin) => this.toPublishState(plugin));
	}

	async publishState(pluginId: string): Promise<PublishPluginState> {
		const plugins = await this.loadPlugins(pluginId, true);
		const plugin = plugins[0];
		if (!plugin) throw new Error("PLUGIN_NOT_FOUND");
		return this.toPublishState(plugin);
	}

	// --- internals ---

	private toPublishState(plugin: StoredPlugin): PublishPluginState {
		return {
			id: plugin.id,
			name: plugin.name,
			description: plugin.description,
			publisherId: plugin.publisher.id,
			categories: [...plugin.categories],
			...(plugin.iconAssetId ? { iconAssetId: plugin.iconAssetId } : {}),
			versions: plugin.versions.map((version) => ({
				version: version.version,
				status: version.status,
				draft: version.draft,
				artifacts: version.artifacts.map((artifact) => ({
					id: artifact.id,
					uploaded: artifact.uploaded,
				})),
			})),
		};
	}

	private async versionState(pluginId: string, version: string): Promise<PublishVersionState | undefined> {
		const state = await this.publishState(pluginId);
		return state.versions.find((entry) => entry.version === version);
	}

	private async requireVersionRow(
		db: QueryRunner,
		pluginId: string,
		version: string,
		lock = false,
	): Promise<VersionRow> {
		const result = await db.query(
			`SELECT plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities
			 FROM plugin_versions WHERE plugin_id = $1 AND version = $2${lock ? " FOR UPDATE" : ""}`,
			[pluginId, version],
		);
		const row = result.rows[0] as VersionRow | undefined;
		if (!row) throw new Error("PLUGIN_VERSION_NOT_FOUND");
		return row;
	}

	async loadPlugins(pluginId: string | undefined, includeDrafts: boolean): Promise<StoredPlugin[]> {
		let pluginResult: QueryResult<PluginRow>;
		if (pluginId === undefined) {
			pluginResult = await this.pool.query(
				"SELECT p.id AS id, p.name AS name, p.description AS description, p.publisher_id AS publisher_id, b.display_name AS publisher_display_name, b.verified AS publisher_verified, p.categories AS categories, p.icon_asset_id AS icon_asset_id, p.published_at AS published_at, p.updated_at AS updated_at FROM plugins p JOIN publishers b ON b.id = p.publisher_id ORDER BY p.id",
			);
		} else {
			pluginResult = await this.pool.query(
				"SELECT p.id AS id, p.name AS name, p.description AS description, p.publisher_id AS publisher_id, b.display_name AS publisher_display_name, b.verified AS publisher_verified, p.categories AS categories, p.icon_asset_id AS icon_asset_id, p.published_at AS published_at, p.updated_at AS updated_at FROM plugins p JOIN publishers b ON b.id = p.publisher_id WHERE p.id = $1",
				[pluginId],
			);
		}

		const pluginRows = pluginResult.rows as PluginRow[];
		if (pluginRows.length === 0) return [];

		const plugins: StoredPlugin[] = [];
		for (const row of pluginRows) {
			const draftClause = includeDrafts ? "" : " AND draft = FALSE";
			const versionResult = await this.pool.query(
				`SELECT plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities FROM plugin_versions WHERE plugin_id = $1${draftClause} ORDER BY version`,
				[row.id],
			);
			const versionRows = versionResult.rows as VersionRow[];
			versionRows.sort((left, right) => compareSemver(left.version, right.version));

			if (versionRows.length === 0 && !includeDrafts) continue;

			const artifactResult = await this.pool.query(
				"SELECT version, artifact_id, target, contains_native_code, preferred, entry, sha256, size, bytes IS NOT NULL OR object_key IS NOT NULL AS uploaded FROM plugin_artifacts WHERE plugin_id = $1 ORDER BY version, artifact_id",
				[row.id],
			);
			const artifactRows = artifactResult.rows as ArtifactRow[];

			const artifactsByVersion = new Map<string, StoredArtifact[]>();
			for (const artifactRow of artifactRows) {
				const list = artifactsByVersion.get(artifactRow.version) ?? [];
				list.push({
					id: artifactRow.artifact_id,
					target: JSON.parse(artifactRow.target) as ArtifactTarget,
					containsNativeCode: artifactRow.contains_native_code,
					preferred: artifactRow.preferred,
					entry: artifactRow.entry,
					sha256: artifactRow.sha256,
					size: artifactRow.size,
					uploaded: artifactRow.uploaded,
				});
				artifactsByVersion.set(artifactRow.version, list);
			}

			plugins.push({
				id: row.id,
				name: row.name,
				description: row.description,
				publisher: {
					id: row.publisher_id,
					displayName: row.publisher_display_name,
					verified: row.publisher_verified,
				},
				categories: JSON.parse(row.categories) as string[],
				...(row.icon_asset_id ? { iconAssetId: row.icon_asset_id } : {}),
				publishedAt: row.published_at,
				updatedAt: row.updated_at,
				versions: versionRows.map((versionRow) => ({
					version: versionRow.version,
					status: versionRow.status as PluginStatus,
					draft: versionRow.draft,
					changelog: versionRow.changelog,
					publishedAt: versionRow.published_at,
					desktop: JSON.parse(versionRow.desktop) as StoredPluginVersion["desktop"],
					...(versionRow.configuration
						? { configuration: JSON.parse(versionRow.configuration) as StoredPluginVersion["configuration"] }
						: {}),
					capabilities: JSON.parse(versionRow.capabilities) as string[],
					artifacts: artifactsByVersion.get(versionRow.version) ?? [],
				})),
			});
		}
		return plugins;
	}
}

async function readArtifactFile(directory: string, objectKey: string): Promise<Buffer | undefined> {
	const root = resolve(directory);
	const path = resolve(root, objectKey);
	if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("Stored artifact object key is unsafe");
	try {
		return await readFile(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
