import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { compare as compareSemver } from "semver";
import { buildArtifact, referencePayloadFiles } from "./artifact-builder.ts";
import { type ListPluginsInput, listPluginPage, type PluginAggregates } from "./catalog-query.ts";
import { parseCatalogDocument } from "./catalog-validation.ts";
import type {
	ArtifactTarget,
	CatalogDocument,
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

export interface MarketplaceStoreOptions {
	databasePath?: string;
	catalogPath?: URL;
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
	configuration?: StoredPluginVersion["configuration"];
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

export interface PublishArtifactAuditContent {
	artifactId: string;
	containsNativeCode: boolean;
	bytes?: Uint8Array;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publishers (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
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
	published_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_versions (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	version TEXT NOT NULL,
	status TEXT NOT NULL,
	draft INTEGER NOT NULL DEFAULT 0,
	changelog TEXT NOT NULL,
	published_at INTEGER NOT NULL,
	desktop TEXT NOT NULL,
	configuration TEXT,
	capabilities TEXT NOT NULL,
	PRIMARY KEY (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS plugin_artifacts (
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	target TEXT NOT NULL,
	contains_native_code INTEGER NOT NULL,
	preferred INTEGER NOT NULL,
	entry TEXT NOT NULL,
	sha256 TEXT,
	size INTEGER,
	bytes BLOB,
	PRIMARY KEY (plugin_id, version, artifact_id),
	FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ratings (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	stars INTEGER NOT NULL,
	review TEXT,
	updated_at INTEGER NOT NULL,
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
`;

interface PluginRow {
	id: string;
	name: string;
	description: string;
	publisher_id: string;
	publisher_display_name: string;
	publisher_verified: number;
	categories: string;
	icon_asset_id: string | null;
	published_at: number;
	updated_at: number;
}

interface VersionRow {
	plugin_id: string;
	version: string;
	status: string;
	draft: number;
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
	contains_native_code: number;
	preferred: number;
	entry: string;
	sha256: string | null;
	size: number | null;
	uploaded: number;
}

export class MarketplaceStore {
	private readonly db: DatabaseSync;
	private readonly clock: () => number;
	private closed = false;

	private constructor(db: DatabaseSync, clock: () => number) {
		this.db = db;
		this.clock = clock;
	}

	static async open(options: MarketplaceStoreOptions): Promise<MarketplaceStore> {
		const catalogUrl = options.catalogPath ?? new URL("../catalog/plugins.json", import.meta.url);
		const source = await readFile(catalogUrl, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch (error) {
			throw new Error(`Marketplace catalog JSON is invalid: ${errorMessage(error)}`);
		}
		const catalog = parseCatalogDocument(parsed);
		const db = new DatabaseSync(options.databasePath ?? ":memory:");
		try {
			db.exec("PRAGMA journal_mode = WAL;");
			db.exec("PRAGMA foreign_keys = ON;");
			db.exec(SCHEMA);
			ensurePluginConfigurationColumn(db);
			const store = new MarketplaceStore(db, options.clock);
			store.seedIfEmpty(catalog, options.marketplaceId);
			return store;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private seedIfEmpty(catalog: CatalogDocument, marketplaceId: string): void {
		const seeded = this.db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
		if (seeded) return;
		this.transaction(() => {
			for (const plugin of catalog.plugins) {
				this.upsertPublisherRow(plugin.publisher.id, plugin.publisher.displayName, plugin.publisher.verified);
				this.db
					.prepare(
						"INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						plugin.id,
						plugin.name,
						plugin.description,
						plugin.publisher.id,
						JSON.stringify(plugin.categories),
						plugin.iconAssetId ?? null,
						plugin.publishedAt,
						plugin.updatedAt,
					);
				for (const version of plugin.versions) {
					this.db
						.prepare(
							"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
						)
						.run(
							plugin.id,
							version.version,
							version.status,
							version.changelog,
							version.publishedAt,
							JSON.stringify(version.desktop),
							version.configuration ? JSON.stringify(version.configuration) : null,
							JSON.stringify(version.capabilities),
						);
					for (const artifact of version.artifacts) {
						const files = referencePayloadFiles();
						const entry = [...files.keys()][0]!;
						const built = buildArtifact({
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
							configuration: version.configuration,
							capabilities: version.capabilities,
							files,
						});
						this.db
							.prepare(
								"INSERT INTO plugin_artifacts (plugin_id, version, artifact_id, target, contains_native_code, preferred, entry, sha256, size, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
							)
							.run(
								plugin.id,
								version.version,
								artifact.id,
								JSON.stringify(artifact.target),
								artifact.containsNativeCode ? 1 : 0,
								artifact.preferred ? 1 : 0,
								entry,
								built.sha256,
								built.size,
								built.bytes,
							);
					}
				}
			}
			this.db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
		});
	}

	// --- public catalog reads ---

	list(input: ListPluginsInput): MarketplacePluginPage {
		const plugins = this.loadPlugins(undefined, false);
		const ratings = this.ratingAggregatesAll();
		const downloads = this.downloadTotalsAll();
		const aggregates = (pluginId: string): PluginAggregates => ({
			rating: ratings.get(pluginId) ?? { count: 0, average: null },
			downloadCount: downloads.get(pluginId) ?? 0,
		});
		return listPluginPage(plugins, input, aggregates);
	}

	getPublicPlugin(pluginId: string): StoredPlugin | undefined {
		return this.loadPlugins(pluginId, false)[0];
	}

	getPublicVersion(pluginId: string, version: string): StoredPluginVersion | undefined {
		return this.getPublicPlugin(pluginId)?.versions.find((entry) => entry.version === version);
	}

	hasPublicPlugin(pluginId: string): boolean {
		return this.getPublicPlugin(pluginId) !== undefined;
	}

	pluginAggregates(pluginId: string): PluginAggregates {
		return {
			rating: this.ratingAggregate(pluginId),
			downloadCount: this.downloadTotal(pluginId),
		};
	}

	getArtifactContent(pluginId: string, version: string, artifactId: string): ArtifactContent | undefined {
		const row = this.db
			.prepare(
				"SELECT a.bytes AS bytes, a.sha256 AS sha256, a.size AS size FROM plugin_artifacts a JOIN plugin_versions v ON v.plugin_id = a.plugin_id AND v.version = a.version WHERE a.plugin_id = ? AND a.version = ? AND a.artifact_id = ? AND v.draft = 0 AND a.bytes IS NOT NULL",
			)
			.get(pluginId, version, artifactId) as { bytes: Uint8Array; sha256: string; size: number } | undefined;
		if (!row) return undefined;
		return { bytes: row.bytes, sha256: row.sha256, size: row.size };
	}

	// --- users and sessions ---

	createUser(username: string, passwordHash: string): StoredUser {
		if (this.getUserByUsername(username)) throw new Error("USERNAME_TAKEN");
		const createdAt = Math.trunc(this.clock());
		const result = this.db
			.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
			.run(username, passwordHash, createdAt);
		return { id: Number(result.lastInsertRowid), username, passwordHash, createdAt };
	}

	getUserByUsername(username: string): StoredUser | undefined {
		const row = this.db
			.prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?")
			.get(username) as { id: number; username: string; password_hash: string; created_at: number } | undefined;
		if (!row) return undefined;
		return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
	}

	createSession(tokenHash: string, userId: number, expiresAt: number): void {
		const now = Math.trunc(this.clock());
		this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
		this.db
			.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
			.run(tokenHash, userId, now, expiresAt);
	}

	getSessionUser(tokenHash: string): SessionUser | undefined {
		const row = this.db
			.prepare(
				"SELECT s.expires_at AS expires_at, u.id AS user_id, u.username AS username, u.created_at AS created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
			)
			.get(tokenHash) as { expires_at: number; user_id: number; username: string; created_at: number } | undefined;
		if (!row) return undefined;
		if (row.expires_at <= this.clock()) {
			this.deleteSession(tokenHash);
			return undefined;
		}
		return { userId: row.user_id, username: row.username, createdAt: row.created_at };
	}

	deleteSession(tokenHash: string): void {
		this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
	}

	// --- publishers ---

	upsertPublisher(publisherId: string, displayName: string, verified: boolean): PublisherAdminView {
		this.upsertPublisherRow(publisherId, displayName, verified);
		return this.publisherView(publisherId)!;
	}

	listPublishers(): PublisherAdminView[] {
		const rows = this.db.prepare("SELECT id FROM publishers ORDER BY id").all() as unknown as Array<{ id: string }>;
		return rows.map((row) => this.publisherView(row.id)!);
	}

	getPublisher(publisherId: string): PublisherRecord | undefined {
		const row = this.db.prepare("SELECT id, display_name, verified FROM publishers WHERE id = ?").get(publisherId) as
			| { id: string; display_name: string; verified: number }
			| undefined;
		if (!row) return undefined;
		return { id: row.id, displayName: row.display_name, verified: row.verified !== 0 };
	}

	addPublisherMember(publisherId: string, username: string): void {
		if (!this.getPublisher(publisherId)) throw new Error("PUBLISHER_NOT_FOUND");
		const user = this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		this.db
			.prepare("INSERT OR IGNORE INTO publisher_members (publisher_id, user_id) VALUES (?, ?)")
			.run(publisherId, user.id);
	}

	removePublisherMember(publisherId: string, username: string): void {
		if (!this.getPublisher(publisherId)) throw new Error("PUBLISHER_NOT_FOUND");
		const user = this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		this.db.prepare("DELETE FROM publisher_members WHERE publisher_id = ? AND user_id = ?").run(publisherId, user.id);
	}

	isPublisherMember(userId: number, publisherId: string): boolean {
		const row = this.db
			.prepare("SELECT 1 AS found FROM publisher_members WHERE publisher_id = ? AND user_id = ?")
			.get(publisherId, userId);
		return row !== undefined;
	}

	publisherIdsForUser(userId: number): string[] {
		const rows = this.db
			.prepare("SELECT publisher_id FROM publisher_members WHERE user_id = ? ORDER BY publisher_id")
			.all(userId) as unknown as Array<{ publisher_id: string }>;
		return rows.map((row) => row.publisher_id);
	}

	// --- publishing ---

	getPluginPublisherId(pluginId: string): string | undefined {
		const row = this.db.prepare("SELECT publisher_id FROM plugins WHERE id = ?").get(pluginId) as
			| { publisher_id: string }
			| undefined;
		return row?.publisher_id;
	}

	upsertPlugin(pluginId: string, request: PublishPluginRequest): PublishPluginState {
		if (!this.getPublisher(request.publisherId)) throw new Error("PUBLISHER_NOT_FOUND");
		const existingPublisher = this.getPluginPublisherId(pluginId);
		if (existingPublisher !== undefined && existingPublisher !== request.publisherId) {
			throw new Error("PLUGIN_PUBLISHER_MISMATCH");
		}
		const now = Math.trunc(this.clock());
		if (existingPublisher === undefined) {
			this.db
				.prepare(
					"INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					pluginId,
					request.name,
					request.description,
					request.publisherId,
					JSON.stringify(request.categories),
					request.iconAssetId ?? null,
					now,
					now,
				);
		} else {
			this.db
				.prepare(
					"UPDATE plugins SET name = ?, description = ?, categories = ?, icon_asset_id = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					request.name,
					request.description,
					JSON.stringify(request.categories),
					request.iconAssetId ?? null,
					now,
					pluginId,
				);
		}
		return this.publishState(pluginId);
	}

	createDraftVersion(pluginId: string, request: PublishVersionRequest): PublishVersionState {
		if (this.getPluginPublisherId(pluginId) === undefined) throw new Error("PLUGIN_NOT_FOUND");
		const existing = this.db
			.prepare("SELECT 1 AS found FROM plugin_versions WHERE plugin_id = ? AND version = ?")
			.get(pluginId, request.version);
		if (existing) throw new Error("PLUGIN_VERSION_EXISTS");
		this.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities) VALUES (?, ?, 'available', 1, ?, 0, ?, ?, ?)",
				)
				.run(
					pluginId,
					request.version,
					request.changelog,
					JSON.stringify(request.desktop),
					request.configuration ? JSON.stringify(request.configuration) : null,
					JSON.stringify(request.capabilities),
				);
			for (const artifact of request.artifacts) {
				this.db
					.prepare(
						"INSERT INTO plugin_artifacts (plugin_id, version, artifact_id, target, contains_native_code, preferred, entry) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						pluginId,
						request.version,
						artifact.id,
						JSON.stringify(artifact.target),
						artifact.containsNativeCode ? 1 : 0,
						artifact.preferred ? 1 : 0,
						artifact.entry,
					);
			}
		});
		return this.versionState(pluginId, request.version)!;
	}

	getUploadContext(pluginId: string, version: string, artifactId: string): ArtifactUploadContext {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft === 0) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const artifactRow = this.db
			.prepare("SELECT target, entry FROM plugin_artifacts WHERE plugin_id = ? AND version = ? AND artifact_id = ?")
			.get(pluginId, version, artifactId) as { target: string; entry: string } | undefined;
		if (!artifactRow) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");
		const pluginRow = this.db.prepare("SELECT name, publisher_id FROM plugins WHERE id = ?").get(pluginId) as
			| { name: string; publisher_id: string }
			| undefined;
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

	putArtifactContent(pluginId: string, version: string, artifactId: string, content: ArtifactContentInput): void {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft === 0) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const result = this.db
			.prepare(
				"UPDATE plugin_artifacts SET sha256 = ?, size = ?, bytes = ? WHERE plugin_id = ? AND version = ? AND artifact_id = ?",
			)
			.run(content.sha256, content.size, content.bytes, pluginId, version, artifactId);
		if (result.changes === 0) throw new Error("PLUGIN_ARTIFACT_NOT_FOUND");
	}

	publishArtifactAuditContents(pluginId: string, version: string): PublishArtifactAuditContent[] {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft === 0) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const rows = this.db
			.prepare(
				"SELECT artifact_id, contains_native_code, bytes FROM plugin_artifacts WHERE plugin_id = ? AND version = ? ORDER BY artifact_id",
			)
			.all(pluginId, version) as Array<{
			artifact_id: string;
			contains_native_code: number;
			bytes: Uint8Array | null;
		}>;
		return rows.map((row) => ({
			artifactId: row.artifact_id,
			containsNativeCode: row.contains_native_code !== 0,
			...(row.bytes ? { bytes: row.bytes } : {}),
		}));
	}

	publishVersion(pluginId: string, version: string): void {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft === 0) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		const pending = this.db
			.prepare(
				"SELECT COUNT(*) AS pending FROM plugin_artifacts WHERE plugin_id = ? AND version = ? AND bytes IS NULL",
			)
			.get(pluginId, version) as { pending: number };
		if (pending.pending > 0) throw new Error("PLUGIN_VERSION_INCOMPLETE");
		const now = Math.trunc(this.clock());
		this.transaction(() => {
			this.db
				.prepare("UPDATE plugin_versions SET draft = 0, published_at = ? WHERE plugin_id = ? AND version = ?")
				.run(now, pluginId, version);
			this.db.prepare("UPDATE plugins SET updated_at = ? WHERE id = ?").run(now, pluginId);
		});
	}

	deleteDraftVersion(pluginId: string, version: string): void {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft === 0) throw new Error("PLUGIN_VERSION_NOT_DRAFT");
		this.db.prepare("DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?").run(pluginId, version);
	}

	deprecateVersion(pluginId: string, version: string): void {
		const versionRow = this.requireVersionRow(pluginId, version);
		if (versionRow.draft !== 0 || versionRow.status !== "available") {
			throw new Error("PLUGIN_VERSION_STATUS_INVALID");
		}
		const now = Math.trunc(this.clock());
		this.transaction(() => {
			this.db
				.prepare("UPDATE plugin_versions SET status = 'deprecated' WHERE plugin_id = ? AND version = ?")
				.run(pluginId, version);
			this.db.prepare("UPDATE plugins SET updated_at = ? WHERE id = ?").run(now, pluginId);
		});
	}

	listPublishStates(publisherIds?: readonly string[]): PublishPluginState[] {
		const allowedPublisherIds = publisherIds ? new Set(publisherIds) : undefined;
		return this.loadPlugins(undefined, true)
			.filter((plugin) => !allowedPublisherIds || allowedPublisherIds.has(plugin.publisher.id))
			.map((plugin) => this.toPublishState(plugin));
	}

	publishState(pluginId: string): PublishPluginState {
		const plugin = this.loadPlugins(pluginId, true)[0];
		if (!plugin) throw new Error("PLUGIN_NOT_FOUND");
		return this.toPublishState(plugin);
	}

	// --- ratings ---

	upsertRating(pluginId: string, userId: number, stars: number, review: string | undefined): void {
		if (!this.hasPublicPlugin(pluginId)) throw new Error("PLUGIN_NOT_FOUND");
		this.db
			.prepare(
				"INSERT INTO ratings (plugin_id, user_id, stars, review, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(plugin_id, user_id) DO UPDATE SET stars = excluded.stars, review = excluded.review, updated_at = excluded.updated_at",
			)
			.run(pluginId, userId, stars, review ?? null, Math.trunc(this.clock()));
	}

	deleteRating(pluginId: string, userId: number): void {
		if (!this.hasPublicPlugin(pluginId)) throw new Error("PLUGIN_NOT_FOUND");
		this.db.prepare("DELETE FROM ratings WHERE plugin_id = ? AND user_id = ?").run(pluginId, userId);
	}

	ratingAggregate(pluginId: string): { count: number; average: number | null } {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count, AVG(stars) AS average FROM ratings WHERE plugin_id = ?")
			.get(pluginId) as { count: number; average: number | null };
		return {
			count: row.count,
			average: row.count > 0 && row.average !== null ? roundAverage(row.average) : null,
		};
	}

	ratingHistogram(pluginId: string): [number, number, number, number, number] {
		const rows = this.db
			.prepare("SELECT stars, COUNT(*) AS count FROM ratings WHERE plugin_id = ? GROUP BY stars")
			.all(pluginId) as unknown as Array<{ stars: number; count: number }>;
		const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0];
		for (const row of rows) {
			if (row.stars >= 1 && row.stars <= 5) histogram[row.stars - 1] = row.count;
		}
		return histogram;
	}

	ratingsFor(pluginId: string, limit: number): PluginRatingEntry[] {
		const rows = this.db
			.prepare(
				"SELECT u.username AS username, r.stars AS stars, r.review AS review, r.updated_at AS updated_at FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.plugin_id = ? ORDER BY r.updated_at DESC, u.username LIMIT ?",
			)
			.all(pluginId, limit) as unknown as Array<{
			username: string;
			stars: number;
			review: string | null;
			updated_at: number;
		}>;
		return rows.map((row) => ({
			username: row.username,
			stars: row.stars,
			...(row.review ? { review: row.review } : {}),
			updatedAt: row.updated_at,
		}));
	}

	private ratingAggregatesAll(): Map<string, { count: number; average: number | null }> {
		const rows = this.db
			.prepare("SELECT plugin_id, COUNT(*) AS count, AVG(stars) AS average FROM ratings GROUP BY plugin_id")
			.all() as unknown as Array<{ plugin_id: string; count: number; average: number | null }>;
		return new Map(
			rows.map((row) => [
				row.plugin_id,
				{ count: row.count, average: row.average !== null ? roundAverage(row.average) : null },
			]),
		);
	}

	// --- downloads ---

	incrementDownload(pluginId: string, version: string, artifactId: string): void {
		this.db
			.prepare(
				"INSERT INTO downloads (plugin_id, version, artifact_id, count) VALUES (?, ?, ?, 1) ON CONFLICT(plugin_id, version, artifact_id) DO UPDATE SET count = count + 1",
			)
			.run(pluginId, version, artifactId);
	}

	downloadTotal(pluginId: string): number {
		const row = this.db
			.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM downloads WHERE plugin_id = ?")
			.get(pluginId) as { total: number };
		return row.total;
	}

	downloadsByVersion(pluginId: string): Record<string, number> {
		const rows = this.db
			.prepare(
				"SELECT version, SUM(count) AS total FROM downloads WHERE plugin_id = ? GROUP BY version ORDER BY version",
			)
			.all(pluginId) as unknown as Array<{ version: string; total: number }>;
		rows.sort((left, right) => compareSemver(left.version, right.version));
		return Object.fromEntries(rows.map((row) => [row.version, row.total]));
	}

	private downloadTotalsAll(): Map<string, number> {
		const rows = this.db
			.prepare("SELECT plugin_id, SUM(count) AS total FROM downloads GROUP BY plugin_id")
			.all() as unknown as Array<{ plugin_id: string; total: number }>;
		return new Map(rows.map((row) => [row.plugin_id, row.total]));
	}

	// --- internals ---

	private versionState(pluginId: string, version: string): PublishVersionState | undefined {
		return this.publishState(pluginId).versions.find((entry) => entry.version === version);
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
					uploaded: artifact.uploaded,
				})),
			})),
		};
	}

	private requireVersionRow(pluginId: string, version: string): VersionRow {
		const row = this.db
			.prepare(
				"SELECT plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities FROM plugin_versions WHERE plugin_id = ? AND version = ?",
			)
			.get(pluginId, version) as VersionRow | undefined;
		if (!row) throw new Error("PLUGIN_VERSION_NOT_FOUND");
		return row;
	}

	private publisherView(publisherId: string): PublisherAdminView | undefined {
		const publisher = this.getPublisher(publisherId);
		if (!publisher) return undefined;
		const members = this.db
			.prepare(
				"SELECT u.username AS username FROM publisher_members m JOIN users u ON u.id = m.user_id WHERE m.publisher_id = ? ORDER BY u.username",
			)
			.all(publisherId) as unknown as Array<{ username: string }>;
		return { ...publisher, members: members.map((row) => row.username) };
	}

	private upsertPublisherRow(publisherId: string, displayName: string, verified: boolean): void {
		this.db
			.prepare(
				"INSERT INTO publishers (id, display_name, verified) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, verified = excluded.verified",
			)
			.run(publisherId, displayName, verified ? 1 : 0);
	}

	private loadPlugins(pluginId: string | undefined, includeDrafts: boolean): StoredPlugin[] {
		const pluginQuery =
			"SELECT p.id AS id, p.name AS name, p.description AS description, p.publisher_id AS publisher_id, b.display_name AS publisher_display_name, b.verified AS publisher_verified, p.categories AS categories, p.icon_asset_id AS icon_asset_id, p.published_at AS published_at, p.updated_at AS updated_at FROM plugins p JOIN publishers b ON b.id = p.publisher_id";
		let pluginRows: PluginRow[];
		if (pluginId === undefined) {
			pluginRows = this.db.prepare(`${pluginQuery} ORDER BY p.id`).all() as unknown as PluginRow[];
		} else {
			const row = this.db.prepare(`${pluginQuery} WHERE p.id = ?`).get(pluginId) as unknown as PluginRow | undefined;
			pluginRows = row ? [row] : [];
		}
		const plugins: StoredPlugin[] = [];
		for (const row of pluginRows) {
			const draftFilter = includeDrafts ? "" : " AND draft = 0";
			const versionRows = this.db
				.prepare(
					`SELECT plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities FROM plugin_versions WHERE plugin_id = ?${draftFilter} ORDER BY version`,
				)
				.all(row.id) as unknown as VersionRow[];
			versionRows.sort((left, right) => compareSemver(left.version, right.version));
			if (versionRows.length === 0 && !includeDrafts) continue;
			const artifactRows = this.db
				.prepare(
					"SELECT version, artifact_id, target, contains_native_code, preferred, entry, sha256, size, bytes IS NOT NULL AS uploaded FROM plugin_artifacts WHERE plugin_id = ? ORDER BY version, artifact_id",
				)
				.all(row.id) as unknown as ArtifactRow[];
			const artifactsByVersion = new Map<string, StoredArtifact[]>();
			for (const artifactRow of artifactRows) {
				const list = artifactsByVersion.get(artifactRow.version) ?? [];
				list.push({
					id: artifactRow.artifact_id,
					target: JSON.parse(artifactRow.target) as ArtifactTarget,
					containsNativeCode: artifactRow.contains_native_code !== 0,
					preferred: artifactRow.preferred !== 0,
					entry: artifactRow.entry,
					sha256: artifactRow.sha256,
					size: artifactRow.size,
					uploaded: artifactRow.uploaded !== 0,
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
					verified: row.publisher_verified !== 0,
				},
				categories: JSON.parse(row.categories) as string[],
				...(row.icon_asset_id ? { iconAssetId: row.icon_asset_id } : {}),
				publishedAt: row.published_at,
				updatedAt: row.updated_at,
				versions: versionRows.map((versionRow) => ({
					version: versionRow.version,
					status: versionRow.status as PluginStatus,
					draft: versionRow.draft !== 0,
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

	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

function ensurePluginConfigurationColumn(db: DatabaseSync): void {
	const columns = db.prepare("PRAGMA table_info(plugin_versions)").all() as unknown as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "configuration")) {
		db.exec("ALTER TABLE plugin_versions ADD COLUMN configuration TEXT");
	}
}

function roundAverage(average: number): number {
	return Math.round(average * 100) / 100;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
