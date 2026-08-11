import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import type { ListPluginsInput } from "../catalog-query.ts";
import { parseCatalogDocument } from "../catalog-validation.ts";
import type {
	ArtifactContent,
	ArtifactContentInput,
	ArtifactUploadContext,
	MarketplacePluginPage,
	PluginIconContent,
	PluginIconContentInput,
	PluginRatingEntry,
	PublishArtifactAuditContent,
	PublisherAdminView,
	PublisherRecord,
	PublishPluginRequest,
	PublishPluginState,
	PublishVersionRequest,
	PublishVersionState,
	StoredPlugin,
	StoredPluginVersion,
} from "../contracts.ts";
import { DownloadStore } from "./download-store.ts";
import { PluginStore } from "./plugin-store.ts";
import { createPool, destroyPool } from "./pool.ts";
import { PublisherStore } from "./publisher-store.ts";
import { RatingStore } from "./rating-store.ts";
import { SCHEMA, SCHEMA_MIGRATIONS } from "./schema.ts";
import { advisoryLockId, seedIfEmpty } from "./seed.ts";
import { type SessionUser, type StoredUser, UserStore } from "./user-store.ts";

export type {
	ArtifactContent,
	ArtifactContentInput,
	ArtifactUploadContext,
	PluginIconContent,
	PluginIconContentInput,
	PublishArtifactAuditContent,
} from "../contracts.ts";
export type { SessionUser, StoredUser } from "./user-store.ts";

export interface MarketplaceStoreOptions {
	pool?: Pool;
	databaseUrl?: string;
	artifactDirectory?: string;
	catalogPath?: URL;
	marketplaceId: string;
	clock(): number;
}

export class MarketplaceStore {
	private readonly pool: Pool;
	private readonly ownsPool: boolean;
	private readonly clock: () => number;
	private closed = false;

	private readonly userStore: UserStore;
	private readonly publisherStore: PublisherStore;
	private readonly pluginStore: PluginStore;
	private readonly ratingStore: RatingStore;
	private readonly downloadStore: DownloadStore;

	private constructor(pool: Pool, ownsPool: boolean, clock: () => number, artifactDirectory?: string) {
		this.pool = pool;
		this.ownsPool = ownsPool;
		this.clock = clock;
		this.userStore = new UserStore(pool);
		this.publisherStore = new PublisherStore(pool);
		this.pluginStore = new PluginStore(pool, artifactDirectory);
		this.ratingStore = new RatingStore(pool);
		this.downloadStore = new DownloadStore(pool);
	}

	static async open(options: MarketplaceStoreOptions): Promise<MarketplaceStore> {
		let pool: Pool | undefined;
		let ownsPool = false;
		if (options.pool) {
			pool = options.pool;
		} else if (options.databaseUrl) {
			pool = createPool(options.databaseUrl);
			ownsPool = true;
		} else {
			throw new Error("MARKETPLACE_DATABASE_URL must be set or a pg Pool must be provided");
		}

		const catalogUrl = options.catalogPath ?? new URL("../../catalog/plugins.json", import.meta.url);
		const source = await readFile(catalogUrl, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch (error) {
			if (ownsPool) await destroyPool(pool);
			throw new Error(`Marketplace catalog JSON is invalid: ${errorMessage(error)}`);
		}
		const catalog = parseCatalogDocument(parsed);

		try {
			await initializeSchema(pool, options.marketplaceId);
			const store = new MarketplaceStore(pool, ownsPool, options.clock, options.artifactDirectory);
			await seedIfEmpty(pool, catalog, options.marketplaceId);
			return store;
		} catch (error) {
			if (ownsPool) await destroyPool(pool);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.ownsPool) {
			await destroyPool(this.pool);
		}
	}

	// --- public catalog reads ---

	async list(input: ListPluginsInput): Promise<MarketplacePluginPage> {
		const [ratings, downloads] = await Promise.all([
			this.ratingStore.ratingAggregatesAll(),
			this.downloadStore.downloadTotalsAll(),
		]);
		return this.pluginStore.list(input, ratings, downloads);
	}

	async getPublicPlugin(pluginId: string): Promise<StoredPlugin | undefined> {
		return this.pluginStore.getPublicPlugin(pluginId);
	}

	async getPublicVersion(pluginId: string, version: string): Promise<StoredPluginVersion | undefined> {
		return this.pluginStore.getPublicVersion(pluginId, version);
	}

	async hasPublicPlugin(pluginId: string): Promise<boolean> {
		return this.pluginStore.hasPublicPlugin(pluginId);
	}

	pluginAggregates(
		pluginId: string,
	): Promise<{ rating: { count: number; average: number | null }; downloadCount: number }> {
		return Promise.all([this.ratingStore.ratingAggregate(pluginId), this.downloadStore.downloadTotal(pluginId)]).then(
			([rating, downloadCount]) => ({ rating, downloadCount }),
		);
	}

	async getArtifactContent(
		pluginId: string,
		version: string,
		artifactId: string,
	): Promise<ArtifactContent | undefined> {
		return this.pluginStore.getArtifactContent(pluginId, version, artifactId);
	}

	async getPluginIcon(pluginId: string): Promise<PluginIconContent | undefined> {
		return this.pluginStore.getPluginIcon(pluginId);
	}

	async putPluginIcon(pluginId: string, content: PluginIconContentInput): Promise<PluginIconContent> {
		return this.pluginStore.putPluginIcon(pluginId, content, Math.trunc(this.clock()));
	}

	// --- users and sessions ---

	async createUser(username: string, passwordHash: string): Promise<StoredUser> {
		return this.userStore.createUser(username, passwordHash, this.clock());
	}

	async getUserByUsername(username: string): Promise<StoredUser | undefined> {
		return this.userStore.getUserByUsername(username);
	}

	async createSession(tokenHash: string, userId: number, expiresAt: number): Promise<void> {
		const now = Math.trunc(this.clock());
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await this.userStore.createSession(client, tokenHash, userId, expiresAt, now);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getSessionUser(tokenHash: string): Promise<SessionUser | undefined> {
		return this.userStore.getSessionUser(tokenHash, this.clock());
	}

	async deleteSession(tokenHash: string): Promise<void> {
		return this.userStore.deleteSession(tokenHash);
	}

	// --- publishers ---

	async upsertPublisher(publisherId: string, displayName: string, verified: boolean): Promise<PublisherAdminView> {
		return this.publisherStore.upsertPublisher(publisherId, displayName, verified);
	}

	async listPublishers(): Promise<PublisherAdminView[]> {
		return this.publisherStore.listPublishers();
	}

	async getPublisher(publisherId: string): Promise<PublisherRecord | undefined> {
		return this.publisherStore.getPublisher(publisherId);
	}

	async addPublisherMember(publisherId: string, username: string): Promise<void> {
		const user = await this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		return this.publisherStore.addPublisherMember(publisherId, user.id);
	}

	async removePublisherMember(publisherId: string, username: string): Promise<void> {
		const user = await this.getUserByUsername(username);
		if (!user) throw new Error("USER_NOT_FOUND");
		return this.publisherStore.removePublisherMember(publisherId, user.id);
	}

	async isPublisherMember(userId: number, publisherId: string): Promise<boolean> {
		return this.publisherStore.isPublisherMember(userId, publisherId);
	}

	async publisherIdsForUser(userId: number): Promise<string[]> {
		return this.publisherStore.publisherIdsForUser(userId);
	}

	// --- publishing ---

	async getPluginPublisherId(pluginId: string): Promise<string | undefined> {
		return this.pluginStore.getPluginPublisherId(pluginId);
	}

	async upsertPlugin(pluginId: string, request: PublishPluginRequest): Promise<PublishPluginState> {
		const publisher = await this.publisherStore.getPublisher(request.publisherId);
		if (!publisher) throw new Error("PUBLISHER_NOT_FOUND");
		return this.pluginStore.upsertPlugin(pluginId, request, Math.trunc(this.clock()));
	}

	async createDraftVersion(pluginId: string, request: PublishVersionRequest): Promise<PublishVersionState> {
		return this.pluginStore.createDraftVersion(pluginId, request);
	}

	async getUploadContext(pluginId: string, version: string, artifactId: string): Promise<ArtifactUploadContext> {
		return this.pluginStore.getUploadContext(pluginId, version, artifactId);
	}

	async putArtifactContent(
		pluginId: string,
		version: string,
		artifactId: string,
		content: ArtifactContentInput,
	): Promise<void> {
		return this.pluginStore.putArtifactContent(pluginId, version, artifactId, content);
	}

	async publishVersion(
		pluginId: string,
		version: string,
		validateArtifact: (artifact: PublishArtifactAuditContent) => void,
	): Promise<void> {
		return this.pluginStore.publishVersion(pluginId, version, Math.trunc(this.clock()), validateArtifact);
	}

	async deleteDraftVersion(pluginId: string, version: string): Promise<void> {
		return this.pluginStore.deleteDraftVersion(pluginId, version);
	}

	async deprecateVersion(pluginId: string, version: string): Promise<void> {
		return this.pluginStore.deprecateVersion(pluginId, version, Math.trunc(this.clock()));
	}

	async listPublishStates(publisherIds?: readonly string[]): Promise<PublishPluginState[]> {
		return this.pluginStore.listPublishStates(publisherIds);
	}

	async publishState(pluginId: string): Promise<PublishPluginState> {
		return this.pluginStore.publishState(pluginId);
	}

	// --- ratings ---

	async upsertRating(pluginId: string, userId: number, stars: number, review: string | undefined): Promise<void> {
		const has = await this.hasPublicPlugin(pluginId);
		if (!has) throw new Error("PLUGIN_NOT_FOUND");
		return this.ratingStore.upsertRating(pluginId, userId, stars, review, this.clock());
	}

	async deleteRating(pluginId: string, userId: number): Promise<void> {
		const has = await this.hasPublicPlugin(pluginId);
		if (!has) throw new Error("PLUGIN_NOT_FOUND");
		return this.ratingStore.deleteRating(pluginId, userId);
	}

	async ratingAggregate(pluginId: string): Promise<{ count: number; average: number | null }> {
		return this.ratingStore.ratingAggregate(pluginId);
	}

	async ratingHistogram(pluginId: string): Promise<[number, number, number, number, number]> {
		return this.ratingStore.ratingHistogram(pluginId);
	}

	async ratingsFor(pluginId: string, limit: number): Promise<PluginRatingEntry[]> {
		return this.ratingStore.ratingsFor(pluginId, limit);
	}

	// --- downloads ---

	async incrementDownload(pluginId: string, version: string, artifactId: string): Promise<void> {
		return this.downloadStore.incrementDownload(pluginId, version, artifactId);
	}

	async downloadTotal(pluginId: string): Promise<number> {
		return this.downloadStore.downloadTotal(pluginId);
	}

	async downloadsByVersion(pluginId: string): Promise<Record<string, number>> {
		return this.downloadStore.downloadsByVersion(pluginId);
	}
}

async function initializeSchema(pool: Pool, marketplaceId: string): Promise<void> {
	const client: PoolClient = await pool.connect();
	const lockId = advisoryLockId(marketplaceId);
	try {
		await client.query("SELECT pg_advisory_lock($1)", [lockId]);
		await client.query(SCHEMA);
		for (const migration of SCHEMA_MIGRATIONS) {
			await client.query(migration);
		}
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
		} finally {
			client.release();
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
