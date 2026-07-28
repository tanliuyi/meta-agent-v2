import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";

export interface MarketplaceServerConfig {
	host: string;
	port: number;
	basePath: string;
	publicBaseUrl: string;
	marketplaceId: string;
	artifactOrigins: string[];
	signingPrivateKey: KeyObject;
	ephemeralSigningKey: boolean;
	databaseUrl: string;
	adminToken?: string;
	maxArtifactBytes: number;
	allowRegistration: boolean;
	maxLoginFailures: number;
}

export function loadMarketplaceServerConfig(env: NodeJS.ProcessEnv = process.env): MarketplaceServerConfig {
	const allowEphemeral = env.MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY === "true";
	const encodedKey = env.MARKETPLACE_SIGNING_PRIVATE_KEY?.trim();
	let signingPrivateKey: KeyObject;
	let ephemeralSigningKey = false;
	if (encodedKey) {
		const source = Buffer.from(encodedKey, "base64").toString("utf8");
		try {
			signingPrivateKey = createPrivateKey(source);
		} catch (error) {
			throw new Error(`MARKETPLACE_SIGNING_PRIVATE_KEY is invalid: ${errorMessage(error)}`);
		}
		if (signingPrivateKey.asymmetricKeyType !== "ed25519") {
			throw new Error("MARKETPLACE_SIGNING_PRIVATE_KEY must contain an Ed25519 private key");
		}
	} else {
		if (!allowEphemeral) {
			throw new Error(
				"MARKETPLACE_SIGNING_PRIVATE_KEY is required unless MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=true",
			);
		}
		signingPrivateKey = generateKeyPairSync("ed25519").privateKey;
		ephemeralSigningKey = true;
	}

	const host = env.MARKETPLACE_HOST?.trim() || "127.0.0.1";
	const port = parsePort(env.MARKETPLACE_PORT);
	const basePath = normalizeBasePath(env.MARKETPLACE_BASE_PATH);
	const fallbackUrl = `http://${host}:${port}${basePath}`;
	const publicBaseUrl = normalizePublicBaseUrl(env.MARKETPLACE_PUBLIC_BASE_URL?.trim() || fallbackUrl);
	assertPublicBasePath(publicBaseUrl, basePath);
	const marketplaceId = normalizeMarketplaceId(env.MARKETPLACE_ID?.trim() || "meta-agent-development");
	const artifactOrigins = parseArtifactOrigins(env.MARKETPLACE_ARTIFACT_ORIGINS, publicBaseUrl);

	const databaseUrl = env.MARKETPLACE_DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error("MARKETPLACE_DATABASE_URL is required (postgresql://...)");
	}
	validateDatabaseUrl(databaseUrl);

	const adminToken = env.MARKETPLACE_ADMIN_TOKEN?.trim() || undefined;
	if (adminToken !== undefined && adminToken.length < 16) {
		throw new Error("MARKETPLACE_ADMIN_TOKEN must be at least 16 characters");
	}
	const maxArtifactBytes = parseMaxArtifactBytes(env.MARKETPLACE_MAX_ARTIFACT_BYTES);
	const allowRegistration = parseBooleanEnv(
		env.MARKETPLACE_ALLOW_REGISTRATION,
		"MARKETPLACE_ALLOW_REGISTRATION",
		true,
	);
	const maxLoginFailures = parseMaxLoginFailures(env.MARKETPLACE_MAX_LOGIN_FAILURES);

	return {
		host,
		port,
		basePath,
		publicBaseUrl,
		marketplaceId,
		artifactOrigins,
		signingPrivateKey,
		ephemeralSigningKey,
		databaseUrl,
		...(adminToken ? { adminToken } : {}),
		maxArtifactBytes,
		allowRegistration,
		maxLoginFailures,
	};
}

function validateDatabaseUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("MARKETPLACE_DATABASE_URL must be a valid URL");
	}
	if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
		throw new Error("MARKETPLACE_DATABASE_URL must use postgresql:// protocol");
	}
	if (!parsed.hostname) {
		throw new Error("MARKETPLACE_DATABASE_URL must include a host");
	}
	if (!parsed.pathname || parsed.pathname === "/") {
		throw new Error("MARKETPLACE_DATABASE_URL must include a database name");
	}
	const dbName = parsed.pathname.slice(1);
	if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
		throw new Error("MARKETPLACE_DATABASE_URL database name is invalid");
	}
}

function parseMaxArtifactBytes(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return 32 * 1024 * 1024;
	const bytes = Number(value);
	if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 1024 * 1024 * 1024) {
		throw new Error("MARKETPLACE_MAX_ARTIFACT_BYTES must be an integer between 1024 and 1073741824");
	}
	return bytes;
}

function parseMaxLoginFailures(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return 10;
	const failures = Number(value);
	if (!Number.isSafeInteger(failures) || failures < 0 || failures > 10_000) {
		throw new Error("MARKETPLACE_MAX_LOGIN_FAILURES must be an integer between 0 and 10000");
	}
	return failures;
}

function parseBooleanEnv(value: string | undefined, label: string, fallback: boolean): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${label} must be true or false`);
}

function parsePort(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return 4317;
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("MARKETPLACE_PORT must be an integer between 1 and 65535");
	}
	return port;
}

function normalizeBasePath(value: string | undefined): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed || trimmed === "/") return "";
	if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("MARKETPLACE_BASE_PATH must be an absolute URL path without traversal, query, or fragment");
	}
	assertSafeUrlPath(trimmed, trimmed, "MARKETPLACE_BASE_PATH");
	return trimmed.replace(/\/+$/, "");
}

function normalizePublicBaseUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("MARKETPLACE_PUBLIC_BASE_URL must use HTTP or HTTPS");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("MARKETPLACE_PUBLIC_BASE_URL cannot contain credentials, query, or fragment");
	}
	assertSafeUrlPath(value, url.pathname, "MARKETPLACE_PUBLIC_BASE_URL");
	return url.href.replace(/\/$/, "");
}

function assertPublicBasePath(publicBaseUrl: string, basePath: string): void {
	const actualPath = new URL(publicBaseUrl).pathname.replace(/\/+$/, "");
	if (actualPath !== basePath) {
		throw new Error("MARKETPLACE_PUBLIC_BASE_URL path must match MARKETPLACE_BASE_PATH");
	}
}

function normalizeMarketplaceId(value: string): string {
	if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value)) {
		throw new Error("MARKETPLACE_ID must be a lowercase marketplace identifier");
	}
	return value;
}

function parseArtifactOrigins(value: string | undefined, publicBaseUrl: string): string[] {
	const sources = (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const origins = [new URL(publicBaseUrl).origin, ...sources].map((source) => {
		const url = new URL(source);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		) {
			throw new Error("MARKETPLACE_ARTIFACT_ORIGINS entries must be HTTP(S) origins without paths or credentials");
		}
		assertSafeUrlPath(source, url.pathname, "MARKETPLACE_ARTIFACT_ORIGINS");
		return url.origin;
	});
	return [...new Set(origins)];
}

function assertSafeUrlPath(source: string, pathname: string, label: string): void {
	if (source !== source.trim() || /\\|[\u0000-\u001f\u007f]/.test(source)) {
		throw new Error(`${label} contains an unsafe path`);
	}
	const authorityEnd = source.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0].length ?? 0;
	const rawPath = source.slice(authorityEnd).split(/[?#]/, 1)[0] ?? "";
	for (const path of [rawPath, pathname]) {
		for (const segment of path.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				throw new Error(`${label} contains an invalid encoded path`);
			}
			if (
				decoded === "." ||
				decoded === ".." ||
				decoded.includes("/") ||
				decoded.includes("\\") ||
				decoded.includes("\0")
			) {
				throw new Error(`${label} contains an unsafe path`);
			}
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
