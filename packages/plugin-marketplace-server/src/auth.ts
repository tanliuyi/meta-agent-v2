import { createHash, randomBytes, type ScryptOptions, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

const SCRYPT_OPTIONS: ScryptOptions = {
	N: SCRYPT_COST,
	r: SCRYPT_BLOCK_SIZE,
	p: SCRYPT_PARALLELIZATION,
};

const DUMMY_SALT = randomBytes(16);

/**
 * A valid-format hash of a random unguessable password. Login verifies unknown
 * usernames against it so the response time does not reveal whether a username exists.
 */
export const DUMMY_PASSWORD_HASH = encodeHash(
	DUMMY_SALT,
	scryptSync(randomBytes(32).toString("base64"), DUMMY_SALT, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS),
);

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
	return encodeHash(salt, hash);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split(":");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const cost = Number(parts[1]);
	const blockSize = Number(parts[2]);
	const parallelization = Number(parts[3]);
	if (
		!Number.isSafeInteger(cost) ||
		cost < 2 ||
		cost > 1 << 20 ||
		!Number.isSafeInteger(blockSize) ||
		blockSize < 1 ||
		blockSize > 32 ||
		!Number.isSafeInteger(parallelization) ||
		parallelization < 1 ||
		parallelization > 4
	) {
		return false;
	}
	const salt = Buffer.from(parts[4] ?? "", "base64");
	const expected = Buffer.from(parts[5] ?? "", "base64");
	if (salt.byteLength < 8 || expected.byteLength < 16) return false;
	const actual = await scryptAsync(password, salt, expected.byteLength, {
		N: cost,
		r: blockSize,
		p: parallelization,
		maxmem: 128 * 1024 * 1024,
	});
	return timingSafeEqual(actual, expected);
}

function encodeHash(salt: Buffer, hash: Buffer): string {
	const parameters = `${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}`;
	return `scrypt:${parameters}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keyLength, options, (error, derivedKey) => {
			if (error) reject(error);
			else resolve(derivedKey);
		});
	});
}

export function generateSessionToken(): { token: string; tokenHash: string } {
	const token = `mkt_${randomBytes(32).toString("base64url")}`;
	return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenEquals(left: string, right: string): boolean {
	return timingSafeEqual(
		createHash("sha256").update(left, "utf8").digest(),
		createHash("sha256").update(right, "utf8").digest(),
	);
}
