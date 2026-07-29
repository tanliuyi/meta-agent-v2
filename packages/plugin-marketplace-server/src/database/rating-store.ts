import type { Pool } from "pg";
import type { PluginRatingEntry } from "../contracts.ts";

export class RatingStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async upsertRating(
		pluginId: string,
		userId: number,
		stars: number,
		review: string | undefined,
		now: number,
	): Promise<void> {
		await this.pool.query(
			"INSERT INTO ratings (plugin_id, user_id, stars, review, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (plugin_id, user_id) DO UPDATE SET stars = EXCLUDED.stars, review = EXCLUDED.review, updated_at = EXCLUDED.updated_at",
			[pluginId, userId, stars, review ?? null, Math.trunc(now)],
		);
	}

	async deleteRating(pluginId: string, userId: number): Promise<void> {
		await this.pool.query("DELETE FROM ratings WHERE plugin_id = $1 AND user_id = $2", [pluginId, userId]);
	}

	async ratingAggregate(pluginId: string): Promise<{ count: number; average: number | null }> {
		const result = await this.pool.query(
			"SELECT COUNT(*)::int AS count, AVG(stars)::float AS average FROM ratings WHERE plugin_id = $1",
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
		const rows = result.rows as Array<{ stars: number; count: number }>;
		const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0];
		for (const row of rows) {
			if (row.stars >= 1 && row.stars <= 5) histogram[row.stars - 1] = row.count;
		}
		return histogram;
	}

	async ratingsFor(pluginId: string, limit: number): Promise<PluginRatingEntry[]> {
		const result = await this.pool.query(
			"SELECT u.username AS username, r.stars AS stars, r.review AS review, r.updated_at AS updated_at FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.plugin_id = $1 ORDER BY r.updated_at DESC, u.username LIMIT $2",
			[pluginId, limit],
		);
		const rows = result.rows as Array<{
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

	async ratingAggregatesAll(): Promise<Map<string, { count: number; average: number | null }>> {
		const result = await this.pool.query(
			"SELECT plugin_id, COUNT(*)::int AS count, AVG(stars)::float AS average FROM ratings GROUP BY plugin_id",
		);
		const rows = result.rows as Array<{ plugin_id: string; count: number; average: number | null }>;
		return new Map(
			rows.map((row) => [
				row.plugin_id,
				{ count: row.count, average: row.average !== null ? roundAverage(row.average) : null },
			]),
		);
	}
}

function roundAverage(average: number): number {
	return Math.round(average * 100) / 100;
}
