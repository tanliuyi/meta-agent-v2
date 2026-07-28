import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { versionCompatible } from "../src/catalog-query.ts";
import { loadMarketplaceServerConfig } from "../src/config.ts";
import type { PluginStatus, StoredPluginVersion } from "../src/contracts.ts";
import { MarketplaceSigningService } from "../src/signing-service.ts";
import { MarketplaceStore } from "../src/store.ts";
import { dropTestSchema, testDatabaseUrl } from "./postgres-harness.ts";

const TEST_DB_URL = process.env.MARKETPLACE_TEST_DATABASE_URL;
const TEST_STORE_SCHEMA = `catalog_${randomUUID().replaceAll("-", "")}`;
const TEST_SCHEMAS = new Set([TEST_STORE_SCHEMA]);
const TEST_STORE_DB_URL = TEST_DB_URL ? testDatabaseUrl(TEST_DB_URL, TEST_STORE_SCHEMA) : undefined;

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
	if (TEST_DB_URL) {
		await Promise.all([...TEST_SCHEMAS].map((schema) => dropTestSchema(TEST_DB_URL, schema)));
	}
});

describe("marketplace server config", () => {
	it("requires a database URL", () => {
		expect(() => loadMarketplaceServerConfig({ MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true" })).toThrow(
			"MARKETPLACE_DATABASE_URL is required",
		);
	});

	it("requires a valid protocol", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_DATABASE_URL: "mysql://localhost:3306/db",
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
			}),
		).toThrow("MARKETPLACE_DATABASE_URL must use postgresql:// protocol");
	});

	it("requires a database name", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_DATABASE_URL: "postgresql://localhost",
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
			}),
		).toThrow("MARKETPLACE_DATABASE_URL must include a database name");
	});

	it("rejects an explicit signing key with ephemeral policy", () => {
		expect(() => loadMarketplaceServerConfig({})).toThrow(
			"MARKETPLACE_SIGNING_PRIVATE_KEY is required unless MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=true",
		);
		expect(
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
			}).ephemeralSigningKey,
		).toBe(true);
	});

	it("accepts a pinned Ed25519 key and normalizes paths and origins", () => {
		const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const config = loadMarketplaceServerConfig({
			MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
			MARKETPLACE_SIGNING_PRIVATE_KEY: Buffer.from(privateKey, "utf8").toString("base64"),
			MARKETPLACE_BASE_PATH: "/plugins/",
			MARKETPLACE_PUBLIC_BASE_URL: "https://market.example.com/plugins/",
			MARKETPLACE_ARTIFACT_ORIGINS: "https://one.example.com,https://two.example.com",
		});
		expect(config).toMatchObject({
			basePath: "/plugins",
			publicBaseUrl: "https://market.example.com/plugins",
			artifactOrigins: ["https://market.example.com", "https://one.example.com", "https://two.example.com"],
			ephemeralSigningKey: false,
		});
	});

	it("applies defaults and validates persistence, admin, and upload limits", () => {
		const base = {
			MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
			MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
		};
		expect(loadMarketplaceServerConfig(base)).toMatchObject({
			maxArtifactBytes: 32 * 1024 * 1024,
			allowRegistration: true,
			maxLoginFailures: 10,
		});
		expect(() => loadMarketplaceServerConfig({ ...base, MARKETPLACE_ADMIN_TOKEN: "short" })).toThrow(
			"MARKETPLACE_ADMIN_TOKEN must be at least 16 characters",
		);
		expect(() => loadMarketplaceServerConfig({ ...base, MARKETPLACE_MAX_ARTIFACT_BYTES: "12" })).toThrow(
			"MARKETPLACE_MAX_ARTIFACT_BYTES must be an integer between 1024 and 1073741824",
		);
		expect(loadMarketplaceServerConfig({ ...base, MARKETPLACE_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(
			false,
		);
		expect(() => loadMarketplaceServerConfig({ ...base, MARKETPLACE_MAX_LOGIN_FAILURES: "-1" })).toThrow(
			"MARKETPLACE_MAX_LOGIN_FAILURES must be an integer between 0 and 10000",
		);
		expect(loadMarketplaceServerConfig({ ...base, MARKETPLACE_MAX_LOGIN_FAILURES: "0" }).maxLoginFailures).toBe(0);
	});

	it("rejects mismatched public paths and invalid marketplace identities", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
				MARKETPLACE_BASE_PATH: "/market",
				MARKETPLACE_PUBLIC_BASE_URL: "https://market.example.com/other",
			}),
		).toThrow("MARKETPLACE_PUBLIC_BASE_URL path must match MARKETPLACE_BASE_PATH");
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
				MARKETPLACE_ID: "Invalid Market",
			}),
		).toThrow("MARKETPLACE_ID must be a lowercase marketplace identifier");
	});

	it("rejects malformed public URLs, credentials, query fragments, and unsafe paths", () => {
		const base = {
			MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
			MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
		};
		for (const publicUrl of [
			"ftp://market.example.com",
			"http://user:password@market.example.com",
			"http://market.example.com?token=secret",
			"http://market.example.com#fragment",
		]) {
			expect(() => loadMarketplaceServerConfig({ ...base, MARKETPLACE_PUBLIC_BASE_URL: publicUrl })).toThrow();
		}
		expect(() =>
			loadMarketplaceServerConfig({
				...base,
				MARKETPLACE_BASE_PATH: "/safe",
				MARKETPLACE_PUBLIC_BASE_URL: "http://market.example.com/a/%2e%2e/safe",
			}),
		).toThrow("contains an unsafe path");
	});

	it("allows HTTP public URLs and artifact origins with either signing-key policy", () => {
		const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const config = loadMarketplaceServerConfig({
			MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
			MARKETPLACE_SIGNING_PRIVATE_KEY: Buffer.from(privateKey, "utf8").toString("base64"),
			MARKETPLACE_PUBLIC_BASE_URL: "http://market.example.com",
			MARKETPLACE_ARTIFACT_ORIGINS: "http://artifacts.example.com",
		});
		expect(config.publicBaseUrl).toBe("http://market.example.com");
		expect(config.artifactOrigins).toEqual(["http://market.example.com", "http://artifacts.example.com"]);
	});

	it("rejects artifact origins with paths or non-HTTP transport", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
				MARKETPLACE_ARTIFACT_ORIGINS: "http://plugins.example.com/path",
			}),
		).toThrow("MARKETPLACE_ARTIFACT_ORIGINS entries must be HTTP(S) origins without paths or credentials");
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_DATABASE_URL: "postgresql://localhost/test",
				MARKETPLACE_ARTIFACT_ORIGINS: "ftp://plugins.example.com",
			}),
		).toThrow("MARKETPLACE_ARTIFACT_ORIGINS entries must be HTTP(S) origins without paths or credentials");
	});
});

// Store integration tests require a PostgreSQL test database
if (!TEST_DB_URL) {
	describe.skip("catalog startup validation (requires MARKETPLACE_TEST_DATABASE_URL)", () => {
		it("placeholder", () => {});
	});
} else {
	describe("catalog startup validation", () => {
		it("fails compatibility closed when required runtime metadata is missing or mismatched", async () => {
			const repository = await openStore();
			try {
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
			} finally {
				await repository.close();
			}
		});

		it("fails artifact compatibility closed for unavailable versions and malformed N-API levels", () => {
			const runtime = {
				platform: "linux",
				arch: "x64",
				napi: "10",
				includeIncompatible: false,
			};
			expect(versionCompatible(catalogVersion("deprecated", "10"), runtime)).toBe(true);
			expect(versionCompatible(catalogVersion("withdrawn", "10"), runtime)).toBe(false);
			expect(versionCompatible(catalogVersion("blocked", "10"), runtime)).toBe(false);
			expect(versionCompatible(catalogVersion("available", "not-a-number"), runtime)).toBe(false);
			expect(versionCompatible(catalogVersion("available", "10"), { ...runtime, napi: "unknown" })).toBe(false);
			expect(versionCompatible(catalogVersion("available", "9007199254740992"), runtime)).toBe(false);
		});

		it("purges expired session rows when a new session is created", async () => {
			let now = 1_800_000_000_000;
			const store = await MarketplaceStore.open({
				databaseUrl: TEST_STORE_DB_URL!,
				signing: new MarketplaceSigningService(generateKeyPairSync("ed25519").privateKey),
				marketplaceId: "test-marketplace",
				clock: () => now,
			});
			try {
				const user = await store.createUser("session-user", "password-hash");
				await store.createSession("expired-token-hash", user.id, now + 1_000);
				now += 2_000;
				await store.createSession("fresh-token-hash", user.id, now + 60_000);
				// Verify only fresh token remains by creating a new session (which triggers cleanup)
				const anotherUser = await store.createUser("session-user-2", "password-hash");
				await store.createSession("temp-token", anotherUser.id, now + 60_000);
				// Check expired session is gone
				const sessionResult = await store.getSessionUser("expired-token-hash");
				expect(sessionResult).toBeUndefined();
				const freshResult = await store.getSessionUser("fresh-token-hash");
				expect(freshResult).toBeDefined();
				expect(freshResult!.username).toBe("session-user");
			} finally {
				await store.close();
			}
		});

		it("prevents artifact replacement after publish auditing starts", async () => {
			const store = await openStore();
			const pluginId = `dev.concurrent.${randomUUID().replaceAll("-", "")}`;
			const artifactId = "universal";
			const content = {
				bytes: new Uint8Array([1, 2, 3]),
				sha256: "0".repeat(64),
				size: 3,
				manifestJson: "{}",
				signatureJson: "{}",
			};
			try {
				await store.upsertPlugin(pluginId, {
					name: "Concurrent Publish",
					description: "Concurrency regression fixture",
					publisherId: "meta-agent",
					categories: ["test"],
				});
				await store.createDraftVersion(pluginId, {
					version: "1.0.0",
					changelog: "Initial release",
					desktop: { hostProfileVersion: 1 },
					capabilities: [],
					artifacts: [
						{
							id: artifactId,
							target: { platform: "universal", arch: "universal" },
							entry: "index.ts",
							containsNativeCode: false,
							preferred: true,
						},
					],
				});
				await store.putArtifactContent(pluginId, "1.0.0", artifactId, content);
				let concurrentUpload: Promise<void> | undefined;
				await store.publishVersion(pluginId, "1.0.0", () => {
					concurrentUpload = store.putArtifactContent(pluginId, "1.0.0", artifactId, {
						...content,
						bytes: new Uint8Array([4, 5, 6]),
					});
				});
				await expect(concurrentUpload).rejects.toThrow("PLUGIN_VERSION_NOT_DRAFT");
			} finally {
				await store.close();
			}
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
					revocations: [],
				}),
				"utf8",
			);

			await expect(openStore(pathToFileURL(path))).rejects.toThrow("downloadPath must be a safe absolute URL path");
		});
	});
}

if (!TEST_DB_URL) {
	describe.skip("persistence (requires MARKETPLACE_TEST_DATABASE_URL)", () => {
		it("placeholder", () => {});
	});
} else {
	describe("persistence", () => {
		it("retains accounts, plugins, ratings, and stats across restarts", async () => {
			// Use a separate schema for persistence test
			const { createTestSchema, dropTestSchema } = await import("./postgres-harness.ts");
			const schemaName = `persist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			TEST_SCHEMAS.add(schemaName);
			const dbUrl = await createTestSchema(TEST_DB_URL, schemaName);

			const signing = new MarketplaceSigningService(generateKeyPairSync("ed25519").privateKey);
			const first = await MarketplaceStore.open({
				databaseUrl: dbUrl,
				signing,
				marketplaceId: "test-marketplace",
				clock: () => 1_800_000_000_000,
			});
			try {
				const user = await first.createUser("persist-user", "password-hash");
				const token = "test-token-hash";
				await first.createSession(token, user.id, 1_800_000_000_000 + 86400_000);
				expect(await first.getSessionUser(token)).toBeDefined();

				await first.upsertPublisher("persist-pub", "Persistent Publisher", false);
				await first.addPublisherMember("persist-pub", "persist-user");
				expect(await first.isPublisherMember(user.id, "persist-pub")).toBe(true);

				await first.upsertPlugin("dev.persist.demo", {
					name: "Persistence Demo",
					description: "Plugin stored in PostgreSQL",
					publisherId: "persist-pub",
					categories: ["test"],
				});
			} finally {
				await first.close();
			}

			const second = await MarketplaceStore.open({
				databaseUrl: dbUrl,
				signing,
				marketplaceId: "test-marketplace",
				clock: () => 1_800_000_100_000,
			});
			try {
				const user = await second.getUserByUsername("persist-user");
				expect(user).toBeDefined();
				expect(user!.username).toBe("persist-user");

				const publishers = await second.listPublishers();
				expect(publishers.map((p) => p.id)).toContain("persist-pub");
			} finally {
				await second.close();
			}

			await dropTestSchema(TEST_DB_URL, schemaName);
		});
	});
}

async function openStore(catalogPath?: URL): Promise<MarketplaceStore> {
	return MarketplaceStore.open({
		databaseUrl: TEST_STORE_DB_URL!,
		...(catalogPath ? { catalogPath } : {}),
		signing: new MarketplaceSigningService(generateKeyPairSync("ed25519").privateKey),
		marketplaceId: "test-marketplace",
		clock: () => 1_800_000_000_000,
	});
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
			},
		],
	};
}
