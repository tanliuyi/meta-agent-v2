import { readFile } from "node:fs/promises";
import { Pool, type PoolClient, types } from "pg";
import { compare as compareSemver } from "semver";
import { buildSignedArtifact, referencePayloadFiles } from "./artifact-builder.ts";
import { type ListPluginsInput, listPluginPage, type PluginAggregates } from "./catalog-query.ts";
import { parseCatalogDocument } from "./catalog-validation.ts";
import type {
	ArtifactTarget,
	CatalogDocument,
	CatalogRevocation,
	MarketplacePluginPage,
	PluginRatingEntry,
	PluginStatus,
	PublisherAdminView,
	PublisherRecord,
	PublishPluginRequest,
	PublishPluginState,
	PublishVersionRequest,
	PublishVersionState,
	StoredArtifact,
	StoredPlugin,
	StoredPluginVersion,
} from "./contracts.ts";
import { canonicalJson, type MarketplaceSigningService } from "./signing-service.ts";

export interface MarketplaceStoreOptions {
	databaseUrl: string;
	catalogPath?: URL;
	signing: MarketplaceSigningService;
	marketplaceId: string;
	clock(): number;
}

export interface StoredUser {
	id: number;
	username: string;
	passwordHash: string;
	createdAt: number;
}

export interface SessionUser {
	userId: number;
	username: string;
	createdAt: number;
}

export interface ArtifactUploadContext {
	pluginName: string;
	publisherId: string;
	desktop: StoredPluginVersion["desktop"];
	capabilities: string[];
	artifact: { id: string; target: ArtifactTarget; entry: string };
}

export interface ArtifactContentInput {
	bytes: Uint8Array;
	sha256: string;
	size: number;
	manifestJson: string;
	signatureJson: string;
}

export interface ArtifactContent {
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

export interface PublishArtifactAuditContent {
	artifactId: string;
	containsNativeCode: boolean;
	bytes?: Uint8Array;
}

const INT8_OID = 20;
types.setTypeParser(INT8_OID, (value) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error("PostgreSQL BIGINT exceeds JavaScript's safe integer range");
	return parsed;
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publishers (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	verified BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at BIGINT NOT NULL,
	expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS publisher_members (
	publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	PRIMARY KEY (publisher_id, user_id)
);
CREATE TABLE IF NOT EXISTS plugins (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	publisher_id TEXT NOT NULL REFERENCES publishers(id),
	categories TEXT NOT NULL,
	icon_asset_id TEXT,
	published_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_versions (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	version TEXT NOT NULL,
	status TEXT NOT NULL,
	draft BOOLEAN NOT NULL DEFAULT FALSE,
	changelog TEXT NOT NULL,
	published_at BIGINT NOT NULL,
	desktop TEXT NOT NULL,
	capabilities TEXT NOT NULL,
	PRIMARY KEY (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS plugin_artifacts (
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	target TEXT NOT NULL,
	contains_native_code BOOLEAN NOT NULL,
	preferred BOOLEAN NOT NULL,
	entry TEXT NOT NULL,
	sha256 TEXT,
	size INTEGER,
	bytes BYTEA,
	manifest TEXT,
	signature TEXT,
	PRIMARY KEY (plugin_id, version, artifact_id),
	FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ratings (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	stars INTEGER NOT NULL,
	review TEXT,
	updated_at BIGINT NOT NULL,
	PRIMARY KEY (plugin_id, user_id)
);
CREATE TABLE IF NOT EXISTS downloads (
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (plugin_id, version, artifact_id),
	FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS revocations (
	id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_ids TEXT,
	status TEXT NOT NULL,
	reason_code TEXT NOT NULL,
	message TEXT NOT NULL,
	replacement_version TEXT
);
`;

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
}

export class MarketplaceStore {
	private readonly pool: Pool;
	private readonly clock: () => number;
	private closed = false;

	private constructor(pool: Pool, clock: () => number) {
		this.pool = pool;
		this.clock = clock;
	}

	static async open(options: MarketplaceStoreOptions): Promise<MarketplaceStore> {
		const catalogUrl = options.catalogPath ?? new URL("../catalog/plugins.json", import.meta.url);
		let source: string;
		try {
			source = await readFile(catalogUrl, "utf8");
		} catch (error) {
			throw new Error(`Cannot read catalog file: ${errorMessage(error)}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch (error) {
			throw new Error(`Marketplace catalog JSON is invalid: ${errorMessage(error)}`);
		}
		const catalog = parseCatalogDocument(parsed);

		const poolOptions = postgresPoolOptions(options.databaseUrl);
		const pool = new Pool({
			connectionString: poolOptions.connectionString,
			...(poolOptions.schema ? { options: `-c search_path=${poolOptions.schema}` } : {}),
			max: 10,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
		});

		let store: MarketplaceStore;
		try {
			const client = await pool.connect();
			try {
				if (poolOptions.schema) {
					await client.query(`CREATE SCHEMA IF NOT EXISTS "${poolOptions.schema}"`);
				}
				await client.query(SCHEMA);
			} finally {
				client.release();
			}
			store = new MarketplaceStore(pool, options.clock);
			await store.seedIfEmpty(catalog, options.signing, options.marketplaceId);
			return store;
		} catch (error) {
			await pool.end().catch(() => {});
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.pool.end();
	}

	private async seedIfEmpty(
		catalog: CatalogDocument,
		signing: MarketplaceSigningService,
		marketplaceId: string,
	): Promise<void> {
		const seeded = await this.pool.query("SELECT value FROM meta WHERE key = 'seeded'");
		if (seeded.rows.length > 0) return;

		await this.transaction(async (client) => {
			// Acquire an advisory transaction lock to prevent concurrent seeding
			await client.query("SELECT pg_advisory_xact_lock(hashtext('marketplace-seed'))");
			// Recheck after lock acquisition
			const recheck = await client.query("SELECT value FROM meta WHERE key = 'seeded'");
			if (recheck.rows.length > 0) return;

			for (const plugin of catalog.plugins) {
				await client.query(
					"INSERT INTO publishers (id, display_name, verified) VALUES ($1, $2, $3) ON CONFLICT(id) DO UPDATE SET display_name = EXCLUDED.display_name, verified = EXCLUDED.verified",
					[plugin.publisher.id, plugin.publisher.displayName, plugin.publisher.verified],
				);
				await client.query(
					"INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
					[
						plugin.id,
						plugin.name,
						plugin.description,
						plugin.publisher.id,
						JSON.stringify(plugin.categories),
						plugin.iconAssetId ?? null,
						plugin.publishedAt,
						plugin.updatedAt,
					],
				);
				for (const version of plugin.versions) {
					await client.query(
						"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, capabilities) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
						[
							plugin.id,
							version.version,
							version.status,
							false,
							version.changelog,
							version.publishedAt,
							JSON.stringify(version.desktop),
							JSON.stringify(version.capabilities),
						],
					);
					for (const artifact of version.artifacts) {
						const files = referencePayloadFiles();
						const entry = [...files.keys()][0]!;
						const built = buildSignedArtifact(signing, {
							marketplaceId,
							artifactId: artifact.id,
							plugin: {
								id: plugin.id,
								name: plugin.name,
								version: version.version,
								publisherId: plugin.publisher.id,
							},
							entry,
							desktop: version.desktop,
							target: artifact.target,
							capabilities: version.capabilities,
							files,
						});
						await client.query(
							"INSERT INTO plugin_artifacts (plugin_id, version, artifact_id, target, contains_native_code, preferred, entry, sha256, size, bytes, manifest, signature) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
							[
								plugin.id,
								version.version,
								artifact.id,
								JSON.stringify(artifact.target),
								artifact.containsNativeCode,
								artifact.preferred,
								entry,
								built.sha256,
								built.size,
								Buffer.from(built.bytes),
								canonicalJson(built.manifest),
								JSON.stringify(built.signature),
							],
						);
					}
				}
			}
			for (const revocation of catalog.revocations) {
				await this.insertRevocationRow(client, revocation);
			}
			await client.query("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
		});
	}

	// --- public catalog reads ---

	async list(input: ListPluginsInput): Promise<MarketplacePluginPage> {
		const plugins = await this.loadPlugins(undefined, false);
		const ratings = await this.ratingAggregatesAll();
		const downloads = await this.downloadTotalsAll();
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

	async pluginAggregates(pluginId: string): Promise<PluginAggregates> {
		return {
			rating: await this.ratingAggregate(pluginId),
			downloadCount: await this.downloadTotal(pluginId),
		};
	}

	async getArtifactContent(
		pluginId: string,
		version: string,
		artifactId: string,
	): Promise<ArtifactContent | undefined> {
		const result = await this.pool.query(
			"SELECT a.bytes, a.sha256, a.size FROM plugin_artifacts a JOIN plugin_versions v ON v.plugin_id = a.plugin_id AND v.version = a.version WHERE a.plugin_id = $1 AND a.version = $2 AND a.artifact_id = $3 AND v.draft = false AND a.sha256 IS NOT NULL",
			[pluginId, version, artifactId],
		);
		if (result.rows.length === 0) return undefined;
		const row = result.rows[0] as { bytes: Buffer; sha256: string; size: number };
		return { bytes: row.bytes, sha256: row.sha256, size: row.size };
	}

	async getRevocations(): Promise<CatalogRevocation[]> {
		const result = await this.pool.query(
			"SELECT plugin_id, version, artifact_ids, status, reason_code, message, replacement_version FROM revocations ORDER BY id",
		);
		return result.rows.map(
			(row: {
				plugin_id: string;
				version: string;
				artifact_ids: string | null;
				status: string;
				reason_code: string;
				message: string;
				replacement_version: string | null;
			}) => ({
				pluginId: row.plugin_id,
				version: row.version,
				...(row.artifact_ids ? { artifactIds: JSON.parse(row.artifact_ids) as string[] } : {}),
				status: row.status as "withdrawn" | "blocked",
				reasonCode: row.reason_code,
				message: row.message,
				...(row.replacement_version ? { replacementVersion: row.replacement_version } : {}),
			}),
		);
	}

	// --- users and sessions ---

	async createUser(username: string, passwordHash: string): Promise<StoredUser> {
		const createdAt = Math.trunc(this.clock());
		try {
			const result = await this.pool.query(
				"INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
				[username, passwordHash, createdAt],
			);
			return {
				id: result.rows[0].id as number,
				username,
				passwordHash,
				createdAt,
			};
		} catch (error: unknown) {
			if (isUniqueViolation(error)) throw new Error("USERNAME_TAKEN");
			throw error;
		}
	}

	async getUserByUsername(username: string): Promise<StoredUser | undefined> {
		const result = await this.pool.query(
			"SELECT id, username, password_hash, created_at FROM users WHERE username = $1",
			[username],
		);
		if (result.rows.length === 0) return undefined;
		const row = result.rows[0] as { id: number; username: string; password_hash: string; created_at: number };
		return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
	}

	async createSession(tokenHash: string, userId: number, expiresAt: number): Promise<void> {
		const now = Math.trunc(this.clock());
		await this.pool.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
		await this.pool.query(
			"INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
			[tokenHash, userId, now, expiresAt],
		);
	}

	async getSessionUser(tokenHash: string): Promise<SessionUser | undefined> {
		const result = await this.pool.query(
			"SELECT s.expires_at, u.id AS user_id, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1",
			[tokenHash],
		);
		if (result.rows.length === 0) return undefined;
		const row = result.rows[0] as { expires_at: number; user_id: number; username: string; created_at: number };
		if (row.expires_at <= this.clock()) {
			await this.deleteSession(tokenHash);
			return undefined;
		}
		return { userId: row.user_id, username: row.username, createdAt: row.created_at };
	}

	async deleteSession(tokenHash: string): Promise<void> {
		await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
	}

	// --- publishers ---

	async upsertPublisher(publisherId: string, displayName: string, verified: boolean): Promise<PublisherAdminView> {
		await this.upsertPublisherRow(publisherId, displayName, verified);
		const publisher = await this.publisherView(publisherId);
		if (!publisher) throw new Error("PUBLISHER_NOT_FOUND");
		return publisher;
	}

	async listPublishers(): Promise<PublisherAdminView[]> {
		const result = await this.pool.query("SELECT id FROM publishers ORDER BY id");
		const views: PublisherAdminView[] = [];
		for (const row of result.rows as Array<{ id: string }>) {
			const view = await this.publisherView(row.id);
			if (view) views.push(view);
		}
		return views;
	}

	async getPublisher(publisherId: string): Promise<PublisherRecord | undefined> {
		const result = await this.pool.query("SELECT id, display_name, verified FROM publishers WHERE id = $1", [
			publisherId,
		]);
		if (result.rows.length === 0) return undefined;
		const row = result.rows[0] as { id: string; display_name: string; verified: boolean };
		return { id: row.id, displayName: row.display_name, verified: row.verified };
	}

	async addPublisherMember(publisherId: string, username: string): Promise<void> {
		if (!(await this.getPublisher(publisherId))) throw new Error("PUBLISHER_NOT_FOUND");
		const user = await this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		await this.pool.query(
			"INSERT INTO publisher_members (publisher_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			[publisherId, user.id],
		);
	}

	async removePublisherMember(publisherId: string, username: string): Promise<void> {
		if (!(await this.getPublisher(publisherId))) throw new Error("PUBLISHER_NOT_FOUND");
		const user = await this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		await this.pool.query("DELETE FROM publisher_members WHERE publisher_id = $1 AND user_id = $2", [
			publisherId,
			user.id,
		]);
	}

	async isPublisherMember(userId: number, publisherId: string): Promise<boolean> {
		const result = await this.pool.query(
			"SELECT 1 AS found FROM publisher_members WHERE publisher_id = $1 AND user_id = $2",
			[publisherId, userId],
		);
		return result.rows.length > 0;
	}

	async publisherIdsForUser(userId: number): Promise<string[]> {
		const result = await this.pool.query(
			"SELECT publisher_id FROM publisher_members WHERE user_id = $1 ORDER BY publisher_id",
			[userId],
		);
		return (result.rows as Array<{ publisher_id: string }>).map((row) => row.publisher_id);
	}

	// --- publishing ---

	async getPluginPublisherId(pluginId: string): Promise<string | undefined> {
		const result = await this.pool.query("SELECT publisher_id FROM plugins WHERE id = $1", [pluginId]);
		if (result.rows.length === 0) return undefined;
		return (result.rows[0] as { publisher_id: string }).publisher_id;
	}

	async upsertPlugin(pluginId: string, request: PublishPluginRequest): Promise<PublishPluginState> {
		if (!(await this.getPublisher(request.publisherId))) throw new Error("PUBLISHER_NOT_FOUND");
		const existingPublisher = await this.getPluginPublisherId(pluginId);
		if (existingPublisher !== undefined && existingPublisher !== request.publisherId) {
			throw new Error("PLUGIN_PUBLISHER_MISMATCH");
		}
		const now = Math.trunc(this.clock());
		if (existingPublisher === undefined) {
			await this.pool.query(
				"INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
				[
					pluginId,
					request.name,
					request.description,
					request.publisherId,
					JSON.stringify(request.categories),
					request.iconAssetId ?? null,
					now,
					now,
				],
			);
		} else {
			await this.pool.query(
				"UPDATE plugins SET name = $1, description = $2, categories = $3, icon_asset_id = $4, updated_at = $5 WHERE id = $6",
				[
					request.name,
					request.description,
					JSON.stringify(request.categories),
					request.iconAssetId ?? null,
					now,
					pluginId,
				],
			);
		}
		return this.publishState(pluginId);
	}

	async createDraftVersion(pluginId: string, request: PublishVersionRequest): Promise<PublishVersionState> {
		if ((await this.getPluginPublisherId(pluginId)) === undefined) throw new Error("PLUGIN_NOT_FOUND");
		const existing = await this.pool.query(
			"SELECT 1 AS found FROM plugin_versions WHERE plugin_id = $1 AND version = $2",
			[pluginId, request.version],
		);
		if (existing.rows.length > 0) throw new Error("PLUGIN_VERSION_EXISTS");

		await this.transaction(async (client) => {
			await client.query(
				"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, capabilities) VALUES ($1, $2, 'available', true, $3, 0, $4, $5)",
				[
					pluginId,
					request.version,
					request.changelog,
					JSON.stringify(request.desktop),
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
		});
		const state = await this.versionState(pluginId, request.version);
		if (!state) throw new Error("PLUGIN_VERSION_NOT_FOUND");
		return state;
	}

	async getUploadContext(pluginId: string, version: string, artifactId: string): Promise<ArtifactUploadContext> {
		const versionRow = await this.requireVersionRow(pluginId, version);
		if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const artifactResult = await this.pool.query(
			"SELECT target, entry FROM plugin_artifacts WHERE plugin_id = $1 AND version = $2 AND artifact_id = $3",
			[pluginId, version, artifactId],
		);
		if (artifactResult.rows.length === 0) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");
		const artifactRow = artifactResult.rows[0] as { target: string; entry: string };
		const pluginResult = await this.pool.query("SELECT name, publisher_id FROM plugins WHERE id = $1", [pluginId]);
		if (pluginResult.rows.length === 0) throw new Error("PLUGIN_NOT_FOUND");
		const pluginRow = pluginResult.rows[0] as { name: string; publisher_id: string };
		return {
			pluginName: pluginRow.name,
			publisherId: pluginRow.publisher_id,
			desktop: JSON.parse(versionRow.desktop) as StoredPluginVersion["desktop"],
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
		await this.transaction(async (client) => {
			const versionRow = await this.requireVersionRow(pluginId, version, client, true);
			if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
			const result = await client.query(
				"UPDATE plugin_artifacts SET sha256 = $1, size = $2, bytes = $3, manifest = $4, signature = $5 WHERE plugin_id = $6 AND version = $7 AND artifact_id = $8",
				[
					content.sha256,
					content.size,
					Buffer.from(content.bytes),
					content.manifestJson,
					content.signatureJson,
					pluginId,
					version,
					artifactId,
				],
			);
			if (result.rowCount === 0) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");
		});
	}

	async publishVersion(
		pluginId: string,
		version: string,
		audit: (artifacts: PublishArtifactAuditContent[]) => void,
	): Promise<void> {
		await this.transaction(async (client) => {
			const versionRow = await this.requireVersionRow(pluginId, version, client, true);
			if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
			const artifactResult = await client.query(
				"SELECT artifact_id, contains_native_code, bytes FROM plugin_artifacts WHERE plugin_id = $1 AND version = $2 ORDER BY artifact_id",
				[pluginId, version],
			);
			const artifacts = (
				artifactResult.rows as Array<{
					artifact_id: string;
					contains_native_code: boolean;
					bytes: Buffer | null;
				}>
			).map((row) => ({
				artifactId: row.artifact_id,
				containsNativeCode: row.contains_native_code,
				...(row.bytes ? { bytes: row.bytes } : {}),
			}));
			audit(artifacts);
			if (artifacts.some((artifact) => artifact.bytes === undefined)) {
				throw new Error("PLUGIN_VERSION_INCOMPLETE");
			}
			const now = Math.trunc(this.clock());
			await client.query(
				"UPDATE plugin_versions SET draft = false, published_at = $1 WHERE plugin_id = $2 AND version = $3",
				[now, pluginId, version],
			);
			await client.query("UPDATE plugins SET updated_at = $1 WHERE id = $2", [now, pluginId]);
		});
	}

	async deleteDraftVersion(pluginId: string, version: string): Promise<void> {
		const versionRow = await this.requireVersionRow(pluginId, version);
		if (!versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		await this.pool.query("DELETE FROM plugin_versions WHERE plugin_id = $1 AND version = $2", [pluginId, version]);
	}

	async deprecateVersion(pluginId: string, version: string): Promise<void> {
		const versionRow = await this.requireVersionRow(pluginId, version);
		if (versionRow.draft || versionRow.status !== "available") {
			throw new Error("PLUGIN_VERSION_STATUS_INVALID");
		}
		const now = Math.trunc(this.clock());
		await this.transaction(async (client) => {
			await client.query("UPDATE plugin_versions SET status = 'deprecated' WHERE plugin_id = $1 AND version = $2", [
				pluginId,
				version,
			]);
			await client.query("UPDATE plugins SET updated_at = $1 WHERE id = $2", [now, pluginId]);
		});
	}

	async applyRevocation(revocation: CatalogRevocation): Promise<void> {
		const versionRow = await this.requireVersionRow(revocation.pluginId, revocation.version);
		if (versionRow.draft) throw new Error("PLUGIN_VERSION_NOT_FOUND");
		if (versionRow.status === "withdrawn" || versionRow.status === "blocked") {
			throw new Error("PLUGIN_VERSION_STATUS_INVALID");
		}
		const now = Math.trunc(this.clock());
		await this.transaction(async (client) => {
			await client.query("UPDATE plugin_versions SET status = $1 WHERE plugin_id = $2 AND version = $3", [
				revocation.status,
				revocation.pluginId,
				revocation.version,
			]);
			await this.insertRevocationRow(client, revocation);
			await client.query("UPDATE plugins SET updated_at = $1 WHERE id = $2", [now, revocation.pluginId]);
		});
	}

	async listPublishStates(publisherIds?: readonly string[]): Promise<PublishPluginState[]> {
		const allowedPublisherIds = publisherIds ? new Set(publisherIds) : undefined;
		const plugins = await this.loadPlugins(undefined, true);
		return plugins
			.filter((plugin) => !allowedPublisherIds || allowedPublisherIds.has(plugin.publisher.id))
			.map((plugin) => this.toPublishState(plugin));
	}

	async publishState(pluginId: string): Promise<PublishPluginState> {
		const plugins = await this.loadPlugins(pluginId, true);
		const plugin = plugins[0];
		if (!plugin) throw new Error("PLUGIN_NOT_FOUND");
		return this.toPublishState(plugin);
	}

	// --- ratings ---

	async upsertRating(pluginId: string, userId: number, stars: number, review: string | undefined): Promise<void> {
		if (!(await this.hasPublicPlugin(pluginId))) throw new Error("PLUGIN_NOT_FOUND");
		await this.pool.query(
			"INSERT INTO ratings (plugin_id, user_id, stars, review, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(plugin_id, user_id) DO UPDATE SET stars = EXCLUDED.stars, review = EXCLUDED.review, updated_at = EXCLUDED.updated_at",
			[pluginId, userId, stars, review ?? null, Math.trunc(this.clock())],
		);
	}

	async deleteRating(pluginId: string, userId: number): Promise<void> {
		if (!(await this.hasPublicPlugin(pluginId))) throw new Error("PLUGIN_NOT_FOUND");
		await this.pool.query("DELETE FROM ratings WHERE plugin_id = $1 AND user_id = $2", [pluginId, userId]);
	}

	async ratingAggregate(pluginId: string): Promise<{ count: number; average: number | null }> {
		const result = await this.pool.query(
			"SELECT COUNT(*)::int AS count, AVG(stars)::double precision AS average FROM ratings WHERE plugin_id = $1",
			[pluginId],
		);
		const row = result.rows[0] as { count: number; average: number | null };
		return {
			count: row.count,
			average: row.count > 0 && row.average !== null ? roundAverage(row.average) : null,
		};
	}

	async ratingHistogram(pluginId: string): Promise<[number, number, number, number, number]> {
		const result = await this.pool.query(
			"SELECT stars, COUNT(*)::int AS count FROM ratings WHERE plugin_id = $1 GROUP BY stars",
			[pluginId],
		);
		const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0];
		for (const row of result.rows as Array<{ stars: number; count: number }>) {
			if (row.stars >= 1 && row.stars <= 5) histogram[row.stars - 1] = row.count;
		}
		return histogram;
	}

	async ratingsFor(pluginId: string, limit: number): Promise<PluginRatingEntry[]> {
		const result = await this.pool.query(
			"SELECT u.username, r.stars, r.review, r.updated_at FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.plugin_id = $1 ORDER BY r.updated_at DESC, u.username LIMIT $2",
			[pluginId, limit],
		);
		return (
			result.rows as Array<{
				username: string;
				stars: number;
				review: string | null;
				updated_at: number;
			}>
		).map((row) => ({
			username: row.username,
			stars: row.stars,
			...(row.review ? { review: row.review } : {}),
			updatedAt: row.updated_at,
		}));
	}

	private async ratingAggregatesAll(): Promise<Map<string, { count: number; average: number | null }>> {
		const result = await this.pool.query(
			"SELECT plugin_id, COUNT(*)::int AS count, AVG(stars)::double precision AS average FROM ratings GROUP BY plugin_id",
		);
		return new Map(
			(
				result.rows as Array<{
					plugin_id: string;
					count: number;
					average: number | null;
				}>
			).map((row) => [
				row.plugin_id,
				{ count: row.count, average: row.average !== null ? roundAverage(row.average) : null },
			]),
		);
	}

	// --- downloads ---

	async incrementDownload(pluginId: string, version: string, artifactId: string): Promise<void> {
		await this.pool.query(
			"INSERT INTO downloads (plugin_id, version, artifact_id, count) VALUES ($1, $2, $3, 1) ON CONFLICT(plugin_id, version, artifact_id) DO UPDATE SET count = downloads.count + 1",
			[pluginId, version, artifactId],
		);
	}

	async downloadTotal(pluginId: string): Promise<number> {
		const result = await this.pool.query(
			"SELECT COALESCE(SUM(count), 0)::int AS total FROM downloads WHERE plugin_id = $1",
			[pluginId],
		);
		return (result.rows[0] as { total: number }).total;
	}

	async downloadsByVersion(pluginId: string): Promise<Record<string, number>> {
		const result = await this.pool.query(
			"SELECT version, SUM(count)::int AS total FROM downloads WHERE plugin_id = $1 GROUP BY version",
			[pluginId],
		);
		const rows = result.rows as Array<{ version: string; total: number }>;
		rows.sort((left, right) => compareSemver(left.version, right.version));
		return Object.fromEntries(rows.map((row) => [row.version, row.total]));
	}

	private async downloadTotalsAll(): Promise<Map<string, number>> {
		const result = await this.pool.query(
			"SELECT plugin_id, SUM(count)::int AS total FROM downloads GROUP BY plugin_id",
		);
		return new Map(
			(result.rows as Array<{ plugin_id: string; total: number }>).map((row) => [row.plugin_id, row.total]),
		);
	}

	// --- internals ---

	private async versionState(pluginId: string, version: string): Promise<PublishVersionState | undefined> {
		const state = await this.publishState(pluginId);
		return state.versions.find((entry) => entry.version === version);
	}

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
					uploaded: artifact.sha256 !== null,
				})),
			})),
		};
	}

	private async requireVersionRow(
		pluginId: string,
		version: string,
		client: Pool | PoolClient = this.pool,
		forUpdate = false,
	): Promise<VersionRow> {
		const result = await client.query(
			`SELECT plugin_id, version, status, draft, changelog, published_at, desktop, capabilities FROM plugin_versions WHERE plugin_id = $1 AND version = $2${forUpdate ? " FOR UPDATE" : ""}`,
			[pluginId, version],
		);
		if (result.rows.length === 0) throw new Error("PLUGIN_VERSION_NOT_FOUND");
		return result.rows[0] as unknown as VersionRow;
	}

	private async publisherView(publisherId: string): Promise<PublisherAdminView | undefined> {
		const publisher = await this.getPublisher(publisherId);
		if (!publisher) return undefined;
		const members = await this.pool.query(
			"SELECT u.username FROM publisher_members m JOIN users u ON u.id = m.user_id WHERE m.publisher_id = $1 ORDER BY u.username",
			[publisherId],
		);
		return {
			...publisher,
			members: (members.rows as Array<{ username: string }>).map((row) => row.username),
		};
	}

	private async upsertPublisherRow(publisherId: string, displayName: string, verified: boolean): Promise<void> {
		await this.pool.query(
			"INSERT INTO publishers (id, display_name, verified) VALUES ($1, $2, $3) ON CONFLICT(id) DO UPDATE SET display_name = EXCLUDED.display_name, verified = EXCLUDED.verified",
			[publisherId, displayName, verified],
		);
	}

	private async insertRevocationRow(client: PoolClient, revocation: CatalogRevocation): Promise<void> {
		await client.query(
			"INSERT INTO revocations (plugin_id, version, artifact_ids, status, reason_code, message, replacement_version) VALUES ($1, $2, $3, $4, $5, $6, $7)",
			[
				revocation.pluginId,
				revocation.version,
				revocation.artifactIds ? JSON.stringify(revocation.artifactIds) : null,
				revocation.status,
				revocation.reasonCode,
				revocation.message,
				revocation.replacementVersion ?? null,
			],
		);
	}

	private async loadPlugins(pluginId: string | undefined, includeDrafts: boolean): Promise<StoredPlugin[]> {
		const pluginQuery = `
SELECT p.id, p.name, p.description, p.publisher_id,
       b.display_name AS publisher_display_name, b.verified AS publisher_verified,
       p.categories, p.icon_asset_id, p.published_at, p.updated_at
FROM plugins p
JOIN publishers b ON b.id = p.publisher_id`;
		let pluginRows: PluginRow[];
		if (pluginId === undefined) {
			const result = await this.pool.query(`${pluginQuery} ORDER BY p.id`);
			pluginRows = result.rows as unknown as PluginRow[];
		} else {
			const result = await this.pool.query(`${pluginQuery} WHERE p.id = $1`, [pluginId]);
			pluginRows = result.rows as unknown as PluginRow[];
		}

		const plugins: StoredPlugin[] = [];
		for (const row of pluginRows) {
			const draftFilter = includeDrafts ? "" : " AND draft = false";
			const versionResult = await this.pool.query(
				`SELECT plugin_id, version, status, draft, changelog, published_at, desktop, capabilities FROM plugin_versions WHERE plugin_id = $1${draftFilter} ORDER BY version`,
				[row.id],
			);
			const versionRows = versionResult.rows as unknown as VersionRow[];
			versionRows.sort((left, right) => compareSemver(left.version, right.version));
			if (versionRows.length === 0 && !includeDrafts) continue;

			const artifactResult = await this.pool.query(
				"SELECT version, artifact_id, target, contains_native_code, preferred, entry, sha256, size FROM plugin_artifacts WHERE plugin_id = $1 ORDER BY version, artifact_id",
				[row.id],
			);
			const artifactRows = artifactResult.rows as unknown as ArtifactRow[];

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
					capabilities: JSON.parse(versionRow.capabilities) as string[],
					artifacts: artifactsByVersion.get(versionRow.version) ?? [],
				})),
			});
		}
		return plugins;
	}

	private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await work(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
}

function postgresPoolOptions(databaseUrl: string): { connectionString: string; schema?: string } {
	const url = new URL(databaseUrl);
	const schema = url.searchParams.get("schema")?.trim();
	url.searchParams.delete("schema");
	if (!schema) return { connectionString: url.href };
	if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
		throw new Error("MARKETPLACE_DATABASE_URL schema is invalid");
	}
	return { connectionString: url.href, schema };
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505"
	);
}

function roundAverage(average: number): number {
	return Math.round(average * 100) / 100;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
