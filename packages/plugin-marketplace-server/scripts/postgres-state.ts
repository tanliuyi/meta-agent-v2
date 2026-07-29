import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const MARKETPLACE_TABLES = [
	"meta",
	"publishers",
	"users",
	"sessions",
	"publisher_members",
	"plugins",
	"plugin_versions",
	"plugin_artifacts",
	"ratings",
	"downloads",
] as const;

export type MarketplacePostgresState = "empty" | "inconsistent" | "populated";

export function classifyMarketplacePostgresState(
	existingTables: ReadonlySet<string>,
	counts: ReadonlyMap<string, number>,
): MarketplacePostgresState {
	if (existingTables.size === 0) return "empty";
	if (existingTables.size !== MARKETPLACE_TABLES.length) return "inconsistent";
	if (MARKETPLACE_TABLES.some((table) => !existingTables.has(table))) return "inconsistent";
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	if (total === 0) return "empty";
	if (
		(counts.get("meta") ?? 0) > 0 &&
		(counts.get("publishers") ?? 0) > 0 &&
		(counts.get("plugins") ?? 0) > 0 &&
		(counts.get("plugin_versions") ?? 0) > 0 &&
		(counts.get("plugin_artifacts") ?? 0) > 0
	) {
		return "populated";
	}
	return "inconsistent";
}

async function main(): Promise<void> {
	const databaseUrl = process.env.MARKETPLACE_DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("MARKETPLACE_DATABASE_URL is required");

	const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
	try {
		const schema = await pool.query<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])",
			[[...MARKETPLACE_TABLES]],
		);
		const existingTables = new Set(schema.rows.map((row) => row.table_name));
		const counts = new Map<string, number>();
		if (existingTables.size === MARKETPLACE_TABLES.length) {
			for (const table of MARKETPLACE_TABLES) {
				const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
				counts.set(table, result.rows[0]?.count ?? 0);
			}
		}
		console.info(classifyMarketplacePostgresState(existingTables, counts));
	} finally {
		await pool.end();
	}
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) await main();
