import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogRepository, versionCompatible } from "../src/catalog-repository.ts";
import { loadMarketplaceServerConfig } from "../src/config.ts";
import type { CatalogPluginVersion, PluginStatus } from "../src/contracts.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("marketplace server config", () => {
	it("requires an explicit signing key policy", () => {
		expect(() => loadMarketplaceServerConfig({})).toThrow(
			"MARKETPLACE_SIGNING_PRIVATE_KEY is required unless MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=true",
		);
		expect(loadMarketplaceServerConfig({ MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true" }).ephemeralSigningKey).toBe(
			true,
		);
	});

	it("accepts a pinned Ed25519 key and normalizes paths and origins", () => {
		const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const config = loadMarketplaceServerConfig({
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

	it("rejects mismatched public paths and invalid marketplace identities", () => {
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_BASE_PATH: "/market",
				MARKETPLACE_PUBLIC_BASE_URL: "https://market.example.com/other",
			}),
		).toThrow("MARKETPLACE_PUBLIC_BASE_URL path must match MARKETPLACE_BASE_PATH");
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_ID: "Invalid Market",
			}),
		).toThrow("MARKETPLACE_ID must be a lowercase marketplace identifier");
	});

	it("rejects malformed public URLs, credentials, query fragments, and unsafe paths", () => {
		const base = { MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true" };
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
				MARKETPLACE_ARTIFACT_ORIGINS: "http://plugins.example.com/path",
			}),
		).toThrow("MARKETPLACE_ARTIFACT_ORIGINS entries must be HTTP(S) origins without paths or credentials");
		expect(() =>
			loadMarketplaceServerConfig({
				MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
				MARKETPLACE_ARTIFACT_ORIGINS: "ftp://plugins.example.com",
			}),
		).toThrow("MARKETPLACE_ARTIFACT_ORIGINS entries must be HTTP(S) origins without paths or credentials");
	});
});

describe("catalog startup validation", () => {
	it("fails compatibility closed when required runtime metadata is missing or mismatched", async () => {
		const repository = await CatalogRepository.load();
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

		await expect(CatalogRepository.load(pathToFileURL(path))).rejects.toThrow(
			"downloadPath must be a safe absolute URL path",
		);
	});
});

function catalogVersion(status: PluginStatus, minimumNapi: string): CatalogPluginVersion {
	return {
		version: "1.0.0",
		status,
		changelog: "fixture",
		publishedAt: 1,
		desktop: { hostProfileVersion: 1 },
		capabilities: [],
		artifacts: [
			{
				id: "artifact",
				target: { platform: "linux", arch: "x64", minimumNapi },
				sha256: "0".repeat(64),
				size: 1,
				downloadPath: "/artifact",
				containsNativeCode: true,
				preferred: true,
			},
		],
	};
}
