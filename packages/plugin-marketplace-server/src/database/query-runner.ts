import type { QueryResult, QueryResultRow } from "pg";

export interface QueryRunner {
	query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
