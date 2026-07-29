import type { Pool } from "pg";
import type { PublisherAdminView, PublisherRecord } from "../contracts.ts";
import type { QueryRunner } from "./query-runner.ts";

export class PublisherStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async upsertPublisher(publisherId: string, displayName: string, verified: boolean): Promise<PublisherAdminView> {
		await this.upsertPublisherRow(this.pool, publisherId, displayName, verified);
		return (await this.publisherView(publisherId))!;
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
		const row = result.rows[0] as { id: string; display_name: string; verified: boolean } | undefined;
		if (!row) return undefined;
		return { id: row.id, displayName: row.display_name, verified: row.verified };
	}

	async addPublisherMember(publisherId: string, userId: number): Promise<void> {
		if (!(await this.getPublisher(publisherId))) throw new Error("PUBLISHER_NOT_FOUND");
		await this.pool.query(
			"INSERT INTO publisher_members (publisher_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			[publisherId, userId],
		);
	}

	async removePublisherMember(publisherId: string, userId: number): Promise<void> {
		if (!(await this.getPublisher(publisherId))) throw new Error("PUBLISHER_NOT_FOUND");
		await this.pool.query("DELETE FROM publisher_members WHERE publisher_id = $1 AND user_id = $2", [
			publisherId,
			userId,
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

	async publisherView(publisherId: string): Promise<PublisherAdminView | undefined> {
		const publisher = await this.getPublisher(publisherId);
		if (!publisher) return undefined;
		const result = await this.pool.query(
			"SELECT u.username AS username FROM publisher_members m JOIN users u ON u.id = m.user_id WHERE m.publisher_id = $1 ORDER BY u.username",
			[publisherId],
		);
		const members = (result.rows as Array<{ username: string }>).map((row) => row.username);
		return { ...publisher, members };
	}

	async upsertPublisherRow(
		db: QueryRunner,
		publisherId: string,
		displayName: string,
		verified: boolean,
	): Promise<void> {
		await db.query(
			"INSERT INTO publishers (id, display_name, verified) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, verified = EXCLUDED.verified",
			[publisherId, displayName, verified],
		);
	}
}
