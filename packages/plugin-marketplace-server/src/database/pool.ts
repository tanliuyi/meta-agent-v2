import { Pool as PgPool, type Pool, types as pgTypes } from "pg";

export type { Pool } from "pg";

const INT8_OID = pgTypes.builtins.INT8;
const getTypeParser: typeof pgTypes.getTypeParser = (oid, format) => {
	if (oid === INT8_OID && format !== "binary") return parseSafeInteger;
	return pgTypes.getTypeParser(oid, format);
};

export function createPool(databaseUrl: string): Pool {
	return new PgPool({ connectionString: databaseUrl, types: { getTypeParser } });
}

export async function destroyPool(pool: Pool): Promise<void> {
	await pool.end();
}

function parseSafeInteger(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new RangeError(`PostgreSQL BIGINT exceeds JavaScript safe range: ${value}`);
	return parsed;
}
