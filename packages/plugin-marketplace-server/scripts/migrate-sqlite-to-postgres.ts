import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { SCHEMA, SCHEMA_MIGRATIONS } from "../src/database/schema.ts";

type SqliteValue = null | number | string | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

interface TableMigration {
	name: string;
	columns: string[];
	booleanColumns?: string[];
	byteaColumns?: string[];
	overrideIdentity?: boolean;
}

const TABLES: TableMigration[] = [
	{ name: "meta", columns: ["key", "value"] },
	{ name: "publishers", columns: ["id", "display_name", "verified"], booleanColumns: ["verified"] },
	{ name: "users", columns: ["id", "username", "password_hash", "created_at"], overrideIdentity: true },
	{ name: "sessions", columns: ["token_hash", "user_id", "created_at", "expires_at"] },
	{ name: "publisher_members", columns: ["publisher_id", "user_id"] },
	{
		name: "plugins",
		columns: ["id", "name", "description", "publisher_id", "categories", "icon_asset_id", "published_at", "updated_at"],
	},
	{
		name: "plugin_versions",
		columns: ["plugin_id", "version", "status", "draft", "changelog", "published_at", "desktop", "configuration", "capabilities"],
		booleanColumns: ["draft"],
	},
	{
		name: "plugin_artifacts",
		columns: ["plugin_id", "version", "artifact_id", "target", "contains_native_code", "preferred", "entry", "sha256", "size", "bytes"],
		booleanColumns: ["contains_native_code", "preferred"],
		byteaColumns: ["bytes"],
	},
	{ name: "ratings", columns: ["plugin_id", "user_id", "stars", "review", "updated_at"] },
	{ name: "downloads", columns: ["plugin_id", "version", "artifact_id", "count"] },
];

async function main(): Promise<void> {
	const sqlitePath = process.argv[2];
	const databaseUrl = process.env.MARKETPLACE_DATABASE_URL?.trim();
	if (!sqlitePath || !databaseUrl) {
		throw new Error("Usage: MARKETPLACE_DATABASE_URL=postgres://... npm run migrate:sqlite -- /path/to/marketplace.db");
	}

	const sqlite = new DatabaseSync(resolve(sqlitePath), { readOnly: true });
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(SCHEMA);
			for (const migration of SCHEMA_MIGRATIONS) {
				await client.query(migration);
			}
			await assertDestinationEmpty(client);
			for (const table of TABLES) {
				await migrateTable(sqlite, client, table);
			}
			await client.query(
				"SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST(COALESCE(MAX(id), 1), 1), MAX(id) IS NOT NULL) FROM users",
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	} finally {
		sqlite.close();
		await pool.end();
	}
}

async function assertDestinationEmpty(client: PoolClient): Promise<void> {
	for (const table of TABLES) {
		const result = await client.query(`SELECT 1 FROM ${table.name} LIMIT 1`);
		if (result.rows.length > 0) {
			throw new Error(`PostgreSQL destination is not empty: ${table.name}`);
		}
	}
}

async function migrateTable(sqlite: DatabaseSync, client: PoolClient, table: TableMigration): Promise<void> {
	const rows = sqlite.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name}`).all() as SqliteRow[];
	const byteaColumns = new Set(table.byteaColumns ?? []);
	const booleanColumns = new Set(table.booleanColumns ?? []);
	const placeholders = table.columns.map((column, index) =>
		byteaColumns.has(column) ? `decode($${index + 1}, 'hex')` : `$${index + 1}`,
	);
	const identityClause = table.overrideIdentity ? " OVERRIDING SYSTEM VALUE" : "";
	const sql = `INSERT INTO ${table.name} (${table.columns.join(", ")})${identityClause} VALUES (${placeholders.join(", ")})`;
	for (const row of rows) {
		const values = table.columns.map((column) => normalizeValue(row[column] ?? null, booleanColumns.has(column), byteaColumns.has(column)));
		await client.query(sql, values);
	}
	console.info(`${table.name}: ${rows.length}`);
}

function normalizeValue(value: SqliteValue, boolean: boolean, bytea: boolean): null | boolean | number | string {
	if (value === null) return null;
	if (boolean) return value !== 0;
	if (bytea) return Buffer.from(value as Uint8Array).toString("hex");
	if (value instanceof Uint8Array) throw new Error("Unexpected SQLite binary value");
	return value;
}

await main();
