export interface MarketplaceServerConfig {
	host: string;
	port: number;
	basePath: string;
	publicBaseUrl: string;
	marketplaceId: string;
	dataDir?: string;
	databaseUrl?: string;
	adminToken?: string;
	maxArtifactBytes: number;
	allowRegistration: boolean;
	maxLoginFailures: number;
}

export function loadMarketplaceServerConfig(env: NodeJS.ProcessEnv = process.env): MarketplaceServerConfig {
	const host = env.MARKETPLACE_HOST?.trim() || "127.0.0.1";
	const port = parsePort(env.MARKETPLACE_PORT);
	const basePath = normalizeBasePath(env.MARKETPLACE_BASE_PATH);
	const fallbackUrl = `http://${host}:${port}${basePath}`;
	const publicBaseUrl = normalizePublicBaseUrl(env.MARKETPLACE_PUBLIC_BASE_URL?.trim() || fallbackUrl);
	assertPublicBasePath(publicBaseUrl, basePath);
	const marketplaceId = normalizeMarketplaceId(env.MARKETPLACE_ID?.trim() || "meta-agent-development");
	const dataDir = env.MARKETPLACE_DATA_DIR?.trim() || undefined;
	const databaseUrl = parseDatabaseUrl(env.MARKETPLACE_DATABASE_URL);
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
		...(dataDir ? { dataDir } : {}),
		...(databaseUrl ? { databaseUrl } : {}),
		...(adminToken ? { adminToken } : {}),
		maxArtifactBytes,
		allowRegistration,
		maxLoginFailures,
	};
}

function parseDatabaseUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("MARKETPLACE_DATABASE_URL must be a valid PostgreSQL URL");
	}
	if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname || !url.pathname.slice(1)) {
		throw new Error("MARKETPLACE_DATABASE_URL must be a valid PostgreSQL URL");
	}
	return trimmed;
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
