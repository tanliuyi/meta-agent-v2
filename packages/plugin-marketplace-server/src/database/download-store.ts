import type { Pool } from "pg";
import { compare as compareSemver } from "semver";

export class DownloadStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async incrementDownload(pluginId: string, version: string, artifactId: string): Promise<void> {
		await this.pool.query(
			"INSERT INTO downloads (plugin_id, version, artifact_id, count) VALUES ($1, $2, $3, 1) ON CONFLICT (plugin_id, version, artifact_id) DO UPDATE SET count = downloads.count + 1",
			[pluginId, version, artifactId],
		);
	}

	async downloadTotal(pluginId: string): Promise<number> {
		const result = await this.pool.query(
			"SELECT COALESCE(SUM(count)::bigint, 0::bigint) AS total FROM downloads WHERE plugin_id = $1",
			[pluginId],
		);
		return Number(result.rows[0].total);
	}

	async downloadsByVersion(pluginId: string): Promise<Record<string, number>> {
		const result = await this.pool.query(
			"SELECT version, SUM(count)::bigint AS total FROM downloads WHERE plugin_id = $1 GROUP BY version",
			[pluginId],
		);
		const rows = result.rows as Array<{ version: string; total: number }>;
		rows.sort((left, right) => compareSemver(left.version, right.version));
		return Object.fromEntries(rows.map((row) => [row.version, Number(row.total)]));
	}

	async downloadTotalsAll(): Promise<Map<string, number>> {
		const result = await this.pool.query(
			"SELECT plugin_id, SUM(count)::bigint AS total FROM downloads GROUP BY plugin_id",
		);
		const rows = result.rows as Array<{ plugin_id: string; total: number }>;
		return new Map(rows.map((row) => [row.plugin_id, Number(row.total)]));
	}
}
