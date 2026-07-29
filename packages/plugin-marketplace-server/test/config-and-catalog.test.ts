import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { versionCompatible } from "../src/catalog-query.ts";
import { loadMarketplaceServerConfig } from "../src/config.ts";
import type { PluginStatus, StoredPluginVersion } from "../src/contracts.ts";
import { MarketplaceStore } from "../src/store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

describe("catalog startup validation", () => {
	it("fails compatibility closed when required runtime metadata is missing or mismatched", async () => {
		const repository = await openStore();
		expect(repository.list({ limit: 20, runtime: { includeIncompatible: false } }).plugins).toEqual([]);
		expect(
			repository.list({
				limit: 20,
				runtime: {
					desktopVersion: "0.0.31",
					piVersion: "0.80.7",
					platform: "linux",
					arch: "x64",
					includeIncompatible: false,
				},
			}).plugins,
		).toHaveLength(1);
		expect(
			repository.list({
				limit: 20,
				runtime: {
					desktopVersion: "0.0.30",
					piVersion: "0.80.7",
					platform: "linux",
					arch: "x64",
					includeIncompatible: false,
				},
			}).plugins,
		).toEqual([]);
		expect(
			repository.list({
				limit: 20,
				runtime: {
					desktopVersion: "not-semver",
					piVersion: "0.80.7",
					platform: "linux",
					arch: "x64",
					includeIncompatible: false,
				},
			}).plugins,
		).toEqual([]);
		repository.close();
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
		const directory = await mkdtemp(join(tmpdir(), "marketplace-sessions-"));
		directories.push(directory);
		const databasePath = join(directory, "marketplace.db");
		let now = 1_800_000_000_000;
		const store = await MarketplaceStore.open({
			databasePath,
			marketplaceId: "test-marketplace",
			clock: () => now,
		});
		try {
			const user = store.createUser("session-user", "password-hash");
			store.createSession("expired-token-hash", user.id, now + 1_000);
			now += 2_000;
			store.createSession("fresh-token-hash", user.id, now + 60_000);
		} finally {
			store.close();
		}
		const db = new DatabaseSync(databasePath);
		try {
			const rows = db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all() as unknown as Array<{
				token_hash: string;
			}>;
			expect(rows.map((row) => row.token_hash)).toEqual(["fresh-token-hash"]);
		} finally {
			db.close();
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
			}),
			"utf8",
		);

		await expect(openStore(pathToFileURL(path))).rejects.toThrow("downloadPath must be a safe absolute URL path");
	});
});

async function openStore(catalogPath?: URL): Promise<MarketplaceStore> {
	return MarketplaceStore.open({
		...(catalogPath ? { catalogPath } : {}),
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
				uploaded: true,
			},
		],
	};
}
