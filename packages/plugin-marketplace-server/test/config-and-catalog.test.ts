import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyMarketplacePostgresState, MARKETPLACE_TABLES } from "../scripts/postgres-state.ts";
import { versionCompatible } from "../src/catalog-query.ts";
import { parseCatalogDocument } from "../src/catalog-validation.ts";
import { loadMarketplaceServerConfig } from "../src/config.ts";
import type { PluginStatus, StoredPluginVersion } from "../src/contracts.ts";
import { MarketplaceStore } from "../src/database/store.ts";
import { createTestPool, destroyTestPool, type TestPoolHandle } from "./pg-mem-helper.ts";

const directories: string[] = [];
const pools: TestPoolHandle[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	for (const handle of pools.splice(0)) {
		await destroyTestPool(handle);
	}
});

describe("marketplace server config", () => {
	it("applies defaults and validates admin and upload limits", () => {
		expect(loadMarketplaceServerConfig({})).toMatchObject({
			maxArtifactBytes: 32 * 1024 * 1024,
			allowRegistration: true,
			maxLoginFailures: 10,
		});
		expect(() => loadMarketplaceServerConfig({ MARKETPLACE_ADMIN_TOKEN: "short" })).toThrow(
			"MARKETPLACE_ADMIN_TOKEN must be at least 16 characters",
		);
		expect(() => loadMarketplaceServerConfig({ MARKETPLACE_MAX_ARTIFACT_BYTES: "12" })).toThrow(
			"MARKETPLACE_MAX_ARTIFACT_BYTES must be an integer between 1024 and 1073741824",
		);
		expect(loadMarketplaceServerConfig({ MARKETPLACE_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(false);
		expect(() => loadMarketplaceServerConfig({ MARKETPLACE_DATABASE_URL: "sqlite:///marketplace.db" })).toThrow(
			"MARKETPLACE_DATABASE_URL must be a valid PostgreSQL URL",
		);
		expect(
			loadMarketplaceServerConfig({
				MARKETPLACE_DATABASE_URL: "postgres://user:password@db.example.com/marketplace",
			}).databaseUrl,
		).toBe("postgres://user:password@db.example.com/marketplace");
		expect(() => loadMarketplaceServerConfig({ MARKETPLACE_MAX_LOGIN_FAILURES: "-1" })).toThrow(
			"MARKETPLACE_MAX_LOGIN_FAILURES must be an integer between 0 and 10000",
		);
		expect(loadMarketplaceServerConfig({ MARKETPLACE_MAX_LOGIN_FAILURES: "0" }).maxLoginFailures).toBe(0);
	});

	it("accepts paths and normalizes URLs", () => {
		const config = loadMarketplaceServerConfig({
			MARKETPLACE_BASE_PATH: "/plugins/",
			MARKETPLACE_PUBLIC_BASE_URL: "https://market.example.com/plugins/",
		});
		expect(config).toMatchObject({
			basePath: "/plugins",
			publicBaseUrl: "https://market.example.com/plugins",
		});
	});

	it("rejects mismatched public paths and invalid marketplace identities", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_BASE_PATH: "/market",
				MARKETPLACE_PUBLIC_BASE_URL: "https://market.example.com/other",
			}),
		).toThrow("MARKETPLACE_PUBLIC_BASE_URL path must match MARKETPLACE_BASE_PATH");
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ID: "Invalid Market",
			}),
		).toThrow("MARKETPLACE_ID must be a lowercase marketplace identifier");
	});

	it("rejects malformed public URLs, credentials, query fragments, and unsafe paths", () => {
		for (const publicUrl of [
			"ftp://market.example.com",
			"http://user:password@market.example.com",
			"http://market.example.com?token=secret",
			"http://market.example.com#fragment",
		]) {
			expect(() => loadMarketplaceServerConfig({ MARKETPLACE_PUBLIC_BASE_URL: publicUrl })).toThrow();
		}
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_BASE_PATH: "/safe",
				MARKETPLACE_PUBLIC_BASE_URL: "http://market.example.com/a/%2e%2e/safe",
			}),
		).toThrow("contains an unsafe path");
	});

	it("allows HTTP public URLs", () => {
		const config = loadMarketplaceServerConfig({
			MARKETPLACE_PUBLIC_BASE_URL: "http://market.example.com",
		});
		expect(config.publicBaseUrl).toBe("http://market.example.com");
	});
});

describe("PostgreSQL deployment state", () => {
	it("distinguishes empty, complete, and partial marketplace databases", () => {
		expect(classifyMarketplacePostgresState(new Set(), new Map())).toBe("empty");
		const tables = new Set<string>(MARKETPLACE_TABLES);
		expect(classifyMarketplacePostgresState(tables, new Map(MARKETPLACE_TABLES.map((table) => [table, 0])))).toBe(
			"empty",
		);
		const populated = new Map<string, number>(MARKETPLACE_TABLES.map((table) => [table, 0]));
		for (const table of ["meta", "publishers", "plugins", "plugin_versions", "plugin_artifacts"]) {
			populated.set(table, 1);
		}
		expect(classifyMarketplacePostgresState(tables, populated)).toBe("populated");
		expect(classifyMarketplacePostgresState(new Set(["meta"]), new Map([["meta", 1]]))).toBe("inconsistent");
		expect(classifyMarketplacePostgresState(tables, new Map([["meta", 1]]))).toBe("inconsistent");
	});
});

describe("catalog startup validation", () => {
	it("fails compatibility closed when required runtime metadata is missing or mismatched", async () => {
		const repository = await openStore();
		expect((await repository.list({ limit: 20, runtime: { includeIncompatible: false } })).plugins).toEqual([]);
		expect(
			(
				await repository.list({
					limit: 20,
					runtime: {
						desktopVersion: "0.0.31",
						piVersion: "0.80.7",
						platform: "linux",
						arch: "x64",
						includeIncompatible: false,
					},
				})
			).plugins,
		).toHaveLength(1);
		expect(
			(
				await repository.list({
					limit: 20,
					runtime: {
						desktopVersion: "0.0.30",
						piVersion: "0.80.7",
						platform: "linux",
						arch: "x64",
						includeIncompatible: false,
					},
				})
			).plugins,
		).toEqual([]);
		expect(
			(
				await repository.list({
					limit: 20,
					runtime: {
						desktopVersion: "not-semver",
						piVersion: "0.80.7",
						platform: "linux",
						arch: "x64",
						includeIncompatible: false,
					},
				})
			).plugins,
		).toEqual([]);
		await repository.close();
	});

	it("fails artifact compatibility closed for malformed N-API levels", () => {
		const runtime = {
			platform: "linux",
			arch: "x64",
			napi: "10",
			includeIncompatible: false,
		};
		expect(versionCompatible(catalogVersion("deprecated", "10"), runtime)).toBe(true);
		expect(versionCompatible(catalogVersion("available", "not-a-number"), runtime)).toBe(false);
		expect(versionCompatible(catalogVersion("available", "10"), { ...runtime, napi: "unknown" })).toBe(false);
		expect(versionCompatible(catalogVersion("available", "9007199254740992"), runtime)).toBe(false);
	});

	it("purges expired session rows when a new session is created", async () => {
		const handle = createTestPool();
		pools.push(handle);
		let now = 1_800_000_000_000;
		const store = await MarketplaceStore.open({
			pool: handle.pool,
			marketplaceId: "test-marketplace",
			clock: () => now,
		});
		try {
			const user = await store.createUser("session-user", "password-hash");
			await store.createSession("expired-token-hash", user.id, now + 1_000);
			now += 2_000;
			await store.createSession("fresh-token-hash", user.id, now + 60_000);
		} finally {
			await store.close();
		}
		// Verify directly via the pool.
		const result = await handle.pool.query("SELECT token_hash FROM sessions ORDER BY token_hash");
		const rows = result.rows as Array<{ token_hash: string }>;
		expect(rows.map((row) => row.token_hash)).toEqual(["fresh-token-hash"]);
	});

	it("reads legacy PostgreSQL object-key artifacts from the data directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "marketplace-objects-"));
		directories.push(directory);
		const handle = createTestPool();
		pools.push(handle);
		const initial = await MarketplaceStore.open({
			pool: handle.pool,
			marketplaceId: "test-marketplace",
			clock: () => 1_800_000_000_000,
		});
		const expected = await initial.getArtifactContent(
			"dev.meta-agent.example-tools",
			"1.0.0",
			"example-tools-1.0.0-universal",
		);
		expect(expected).toBeDefined();
		await initial.close();
		const objectKey = "artifacts/sha256/test.meta-plugin";
		const objectPath = join(directory, objectKey);
		await mkdir(join(directory, "artifacts/sha256"), { recursive: true });
		await writeFile(objectPath, expected!.bytes);
		await handle.pool.query(
			"UPDATE plugin_artifacts SET bytes = NULL, object_key = $1 WHERE plugin_id = $2 AND version = $3 AND artifact_id = $4",
			[objectKey, "dev.meta-agent.example-tools", "1.0.0", "example-tools-1.0.0-universal"],
		);
		const reopened = await MarketplaceStore.open({
			pool: handle.pool,
			artifactDirectory: directory,
			marketplaceId: "test-marketplace",
			clock: () => 1_800_000_000_000,
		});
		const actual = await reopened.getArtifactContent(
			"dev.meta-agent.example-tools",
			"1.0.0",
			"example-tools-1.0.0-universal",
		);
		expect(actual).toEqual(expected);
		await handle.pool.query(
			"UPDATE plugin_artifacts SET object_key = $1 WHERE plugin_id = $2 AND version = $3 AND artifact_id = $4",
			["../escape.meta-plugin", "dev.meta-agent.example-tools", "1.0.0", "example-tools-1.0.0-universal"],
		);
		await expect(
			reopened.getArtifactContent("dev.meta-agent.example-tools", "1.0.0", "example-tools-1.0.0-universal"),
		).rejects.toThrow("Stored artifact object key is unsafe");
		await reopened.close();
	});

	it.each([
		["zero", [false]],
		["multiple", [true, true]],
	] as const)("rejects catalogs with %s preferred artifacts", (_label, preferredValues) => {
		expect(() => parseCatalogDocument(catalogWithPreferredArtifacts(preferredValues))).toThrow(
			"artifacts must include exactly one preferred entry",
		);
	});

	it("rejects unsafe download paths before serving requests", async () => {
		const directory = await mkdtemp(join(tmpdir(), "marketplace-catalog-"));
		directories.push(directory);
		const path = join(directory, "plugins.json");
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				plugins: [
					{
						id: "invalid.plugin",
						name: "Invalid",
						description: "Invalid fixture",
						publisher: { id: "publisher", displayName: "Publisher", verified: false },
						categories: ["test"],
						publishedAt: 1,
						updatedAt: 1,
						versions: [
							{
								version: "1.0.0",
								status: "available",
								changelog: "fixture",
								publishedAt: 1,
								desktop: { hostProfileVersion: 1 },
								capabilities: [],
								artifacts: [
									{
										id: "bad",
										target: { platform: "universal", arch: "universal" },
										sha256: "0".repeat(64),
										size: 1,
										downloadPath: "/../escape",
										containsNativeCode: false,
										preferred: true,
									},
								],
							},
						],
					},
				],
			}),
			"utf8",
		);

		await expect(openStore(pathToFileURL(path))).rejects.toThrow("downloadPath must be a safe absolute URL path");
	});
});

async function openStore(catalogPath?: URL): Promise<MarketplaceStore> {
	const handle = createTestPool();
	pools.push(handle);
	return MarketplaceStore.open({
		pool: handle.pool,
		...(catalogPath ? { catalogPath } : {}),
		marketplaceId: "test-marketplace",
		clock: () => 1_800_000_000_000,
	});
}

function catalogWithPreferredArtifacts(preferredValues: readonly boolean[]) {
	return {
		schemaVersion: 1,
		plugins: [
			{
				id: "preferred.test",
				name: "Preferred Test",
				description: "Preferred artifact validation fixture",
				publisher: { id: "publisher", displayName: "Publisher", verified: false },
				categories: ["test"],
				publishedAt: 1,
				updatedAt: 1,
				versions: [
					{
						version: "1.0.0",
						status: "available",
						changelog: "fixture",
						publishedAt: 1,
						desktop: { hostProfileVersion: 1 },
						capabilities: [],
						artifacts: preferredValues.map((preferred, index) => ({
							id: `artifact-${index}`,
							target: { platform: "universal", arch: "universal" },
							sha256: "0".repeat(64),
							size: 1,
							downloadPath: `/artifact-${index}`,
							containsNativeCode: false,
							preferred,
						})),
					},
				],
			},
		],
	};
}

function catalogVersion(status: PluginStatus, minimumNapi: string): StoredPluginVersion {
	return {
		version: "1.0.0",
		status,
		draft: false,
		changelog: "fixture",
		publishedAt: 1,
		desktop: { hostProfileVersion: 1 },
		capabilities: [],
		artifacts: [
			{
				id: "artifact",
				target: { platform: "linux", arch: "x64", minimumNapi },
				containsNativeCode: true,
				preferred: true,
				entry: "index.ts",
				sha256: "0".repeat(64),
				size: 1,
				uploaded: true,
			},
		],
	};
}
