import pg from "pg";

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function testDatabaseUrl(baseUrl: string, schemaName: string): string {
	assertSchemaName(schemaName);
	const url = new URL(baseUrl);
	url.searchParams.set("schema", schemaName);
	return url.href;
}

export async function createTestSchema(baseUrl: string, schemaName: string): Promise<string> {
	assertSchemaName(schemaName);
	const pool = new pg.Pool({ connectionString: baseUrl, max: 2, connectionTimeoutMillis: 5_000 });
	try {
		await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
	} finally {
		await pool.end();
	}
	return testDatabaseUrl(baseUrl, schemaName);
}

export async function dropTestSchema(baseUrl: string, schemaName: string): Promise<void> {
	assertSchemaName(schemaName);
	const pool = new pg.Pool({ connectionString: baseUrl, max: 2, connectionTimeoutMillis: 5_000 });
	try {
		await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
	} finally {
		await pool.end();
	}
}

function assertSchemaName(schemaName: string): void {
	if (!SCHEMA_PATTERN.test(schemaName)) throw new Error("PostgreSQL test schema name is invalid");
}
