import type { Pool } from "pg";
import type { QueryRunner } from "./query-runner.ts";
import { isUniqueViolation } from "./query-runner.ts";

export interface StoredUser {
	id: number;
	username: string;
	passwordHash: string;
	createdAt: number;
}

export interface SessionUser {
	userId: number;
	username: string;
	createdAt: number;
}

export class UserStore {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async createUser(username: string, passwordHash: string, now: number): Promise<StoredUser> {
		const createdAt = Math.trunc(now);
		try {
			const result = await this.pool.query(
				"INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
				[username, passwordHash, createdAt],
			);
			return { id: Number(result.rows[0].id), username, passwordHash, createdAt };
		} catch (error) {
			if (isUniqueViolation(error)) throw new Error("USERNAME_TAKEN");
			throw error;
		}
	}

	async getUserByUsername(username: string): Promise<StoredUser | undefined> {
		const result = await this.pool.query(
			"SELECT id, username, password_hash, created_at FROM users WHERE username = $1",
			[username],
		);
		const row = result.rows[0] as
			| { id: number; username: string; password_hash: string; created_at: number }
			| undefined;
		if (!row) return undefined;
		return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at };
	}

	async createSession(
		db: QueryRunner,
		tokenHash: string,
		userId: number,
		expiresAt: number,
		now: number,
	): Promise<void> {
		await db.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
		await db.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
			tokenHash,
			userId,
			now,
			expiresAt,
		]);
	}

	async getSessionUser(tokenHash: string, now: number): Promise<SessionUser | undefined> {
		const result = await this.pool.query(
			"SELECT s.expires_at AS expires_at, u.id AS user_id, u.username AS username, u.created_at AS created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1",
			[tokenHash],
		);
		const row = result.rows[0] as
			| { expires_at: number; user_id: number; username: string; created_at: number }
			| undefined;
		if (!row) return undefined;
		if (row.expires_at <= now) {
			await this.deleteSession(tokenHash);
			return undefined;
		}
		return { userId: row.user_id, username: row.username, createdAt: row.created_at };
	}

	async deleteSession(tokenHash: string): Promise<void> {
		await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
	}
}
