import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";

export interface TestPoolHandle {
	pool: Pool;
	/** Release the underlying pg-mem database and pool. */
	destroy(): Promise<void>;
}

/**
 * Create a pg-mem backed Pool for isolated tests.
 * Registers mock implementations for pg_try_advisory_lock and pg_advisory_unlock.
 */
export function createTestPool(): TestPoolHandle {
	const db = newDb({ noAstCoverageCheck: true });
	// Register advisory lock functions that pg-mem does not implement natively.
	db.public.registerFunction({
		name: "pg_advisory_lock",
		args: [DataType.bigint],
		returns: DataType.bool,
		implementation: () => true,
	});
	db.public.registerFunction({
		name: "pg_advisory_unlock",
		args: [DataType.bigint],
		returns: DataType.bool,
		implementation: () => true,
	});
	db.public.registerFunction({
		name: "pg_advisory_xact_lock",
		args: [DataType.bigint],
		returns: DataType.bool,
		implementation: () => true,
	});
	db.public.registerFunction({
		name: "decode",
		args: [DataType.text, DataType.text],
		returns: DataType.bytea,
		implementation: (value: string, encoding: string) => {
			if (encoding !== "hex") throw new Error(`Unsupported test decode encoding: ${encoding}`);
			return Buffer.from(value, "hex");
		},
	});
	const pg = db.adapters.createPg();
	const pool = new pg.Pool() as Pool;
	return {
		pool,
		destroy: async () => {
			await pool.end();
		},
	};
}

export async function destroyTestPool(handle: TestPoolHandle): Promise<void> {
	await handle.destroy();
}
