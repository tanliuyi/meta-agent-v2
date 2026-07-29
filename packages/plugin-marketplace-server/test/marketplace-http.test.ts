import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { strFromU8, unzipSync } from "fflate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketplaceServerConfig } from "../src/config.ts";
import { createMarketplaceApp } from "../src/create-app.ts";

interface ErrorBody {
	error: { code: string; message: string };
}

const config: MarketplaceServerConfig = {
	host: "127.0.0.1",
	port: 4317,
	basePath: "/market",
	publicBaseUrl: "https://market.example.com/market",
	marketplaceId: "test-marketplace",
	maxArtifactBytes: 32 * 1024 * 1024,
	allowRegistration: true,
	maxLoginFailures: 10,
};

let app: INestApplication;
const clockNow = 1_800_000_000_000;

beforeAll(async () => {
	app = await createMarketplaceApp({
		config,
		clock: () => clockNow,
		logger: false,
	});
	await app.init();
});

afterAll(async () => {
	await app.close();
});

describe("plugin marketplace HTTP API", () => {
	it("serves health and plain discovery beneath the configured base path", async () => {
		await request(app.getHttpServer()).get("/market/health").expect(200, {
			status: "ok",
			marketplaceId: "test-marketplace",
		});

		const response = await request(app.getHttpServer())
			.get("/market/.well-known/meta-agent-marketplace.json")
			.expect(200);
		expect(response.body).toEqual({
			protocolVersion: 1,
			marketplaceId: "test-marketplace",
			apiRoot: "https://market.example.com/market/v1",
		});
	});

	it("lists and searches compatible plugins with bounded query validation", async () => {
		const response = await request(app.getHttpServer())
			.get("/market/v1/plugins")
			.query({
				query: "reference",
				desktopVersion: "0.0.31",
				piVersion: "0.80.7",
				platform: "linux",
				arch: "x64",
				limit: "10",
			})
			.expect(200);
		expect(response.body).toMatchObject({
			plugins: [
				{
					id: "dev.meta-agent.example-tools",
					latestVersion: "1.1.0",
					compatibleVersion: "1.1.0",
					containsNativeCode: false,
					capabilities: ["tools.register", "commands.register"],
					status: "available",
				},
			],
		});

		const malformedDesktopVersion = await request(app.getHttpServer())
			.get("/market/v1/plugins")
			.query({
				desktopVersion: "not-semver",
				piVersion: "0.80.7",
				platform: "linux",
				arch: "x64",
				limit: "10",
			})
			.expect(200);
		expect(malformedDesktopVersion.body).toEqual({ plugins: [] });

		const invalid = await request(app.getHttpServer()).get("/market/v1/plugins").query({ limit: "101" }).expect(400);
		expect(invalid.body as ErrorBody).toEqual({
			error: { code: "QUERY_INVALID", message: "limit must be between 1 and 100" },
		});
	});

	it("keeps deprecated versions installable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "marketplace-status-http-"));
		const catalogPath = join(directory, "plugins.json");
		let statusApp: INestApplication | undefined;
		try {
			await writeFile(catalogPath, JSON.stringify(statusCatalog()), "utf8");
			statusApp = await createMarketplaceApp({
				config,
				catalogPath: pathToFileURL(catalogPath),
				clock: () => 1_800_000_000_000,
				logger: false,
			});
			await statusApp.init();
			const server = statusApp.getHttpServer();
			const page = await request(server).get("/market/v1/plugins").expect(200);
			expect(page.body).toMatchObject({
				plugins: [
					{
						id: "status.plugin",
						latestVersion: "1.0.0",
						compatibleVersion: "1.0.0",
						status: "deprecated",
					},
				],
			});
			await request(server).get("/market/v1/plugins/status.plugin/versions/1.0.0/artifacts").expect(200);
		} finally {
			await statusApp?.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("returns plugin, version, artifact, and safe download metadata", async () => {
		const detail = await request(app.getHttpServer())
			.get("/market/v1/plugins/dev.meta-agent.example-tools")
			.expect(200);
		expect(detail.body).toMatchObject({
			id: "dev.meta-agent.example-tools",
			latestVersion: "1.1.0",
		});
		expect(detail.body.versions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: "1.0.0" }),
				expect.objectContaining({ version: "1.1.0" }),
			]),
		);

		const versions = await request(app.getHttpServer())
			.get("/market/v1/plugins/dev.meta-agent.example-tools/versions")
			.expect(200);
		expect(versions.body).toHaveLength(2);

		const version = await request(app.getHttpServer())
			.get("/market/v1/plugins/dev.meta-agent.example-tools/versions/1.0.0")
			.expect(200);
		expect(version.body).toMatchObject({ version: "1.0.0", status: "available" });

		const artifacts = await request(app.getHttpServer())
			.get("/market/v1/plugins/dev.meta-agent.example-tools/versions/1.0.0/artifacts")
			.expect(200);
		expect(artifacts.body).toMatchObject({
			artifacts: [
				{
					id: "example-tools-1.0.0-universal",
					downloadEndpoint:
						"https://market.example.com/market/v1/plugins/dev.meta-agent.example-tools/versions/1.0.0/artifacts/example-tools-1.0.0-universal/download",
				},
			],
		});
		const artifactMetadata = (artifacts.body as { artifacts: Array<{ sha256: string; size: number }> }).artifacts[0]!;
		expect(artifactMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(artifactMetadata.sha256).not.toBe("0".repeat(64));
		expect(artifactMetadata.size).toBeGreaterThan(0);

		const download = await request(app.getHttpServer())
			.get(
				"/market/v1/plugins/dev.meta-agent.example-tools/versions/1.0.0/artifacts/example-tools-1.0.0-universal/download",
			)
			.expect(200);
		expect(download.body).toEqual({
			pluginId: "dev.meta-agent.example-tools",
			version: "1.0.0",
			artifactId: "example-tools-1.0.0-universal",
			url: "https://market.example.com/market/v1/artifacts/dev.meta-agent.example-tools/1.0.0/example-tools-1.0.0-universal",
			sha256: artifactMetadata.sha256,
			size: artifactMetadata.size,
		});

		const bytesResponse = await request(app.getHttpServer())
			.get("/market/v1/artifacts/dev.meta-agent.example-tools/1.0.0/example-tools-1.0.0-universal")
			.buffer(true)
			.parse((response, callback) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => callback(null, Buffer.concat(chunks)));
				response.on("error", (error: Error) => callback(error, Buffer.alloc(0)));
			})
			.expect(200)
			.expect("content-type", /application\/vnd\.meta-agent\.plugin\+zip/)
			.expect("cache-control", "public, max-age=31536000, immutable");
		const bytes = bytesResponse.body as Buffer;
		expect(bytes.byteLength).toBe(download.body.size);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(download.body.sha256);
		const archive = unzipSync(bytes);
		expect(Object.keys(archive).sort()).toEqual(["market-manifest.json", "payload/index.ts"]);
		const manifest = JSON.parse(strFromU8(archive["market-manifest.json"]!)) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			schemaVersion: 1,
			marketplaceId: "test-marketplace",
			artifactId: "example-tools-1.0.0-universal",
			plugin: { id: "dev.meta-agent.example-tools", version: "1.0.0" },
			pi: { entry: "payload/index.ts" },
			nativeModules: [],
			executables: [],
		});
	});

	it("returns stable not-found errors", async () => {
		const response = await request(app.getHttpServer()).get("/market/v1/plugins/missing.plugin").expect(404);
		expect(response.body as ErrorBody).toEqual({
			error: { code: "PLUGIN_NOT_FOUND", message: "Plugin not found: missing.plugin" },
		});
	});
});

function statusCatalog() {
	return {
		schemaVersion: 1,
		plugins: [
			{
				id: "status.plugin",
				name: "Status Plugin",
				description: "Status fixture",
				publisher: { id: "publisher", displayName: "Publisher", verified: true },
				categories: ["test"],
				publishedAt: 1,
				updatedAt: 1,
				versions: [
					{
						version: "1.0.0",
						status: "deprecated",
						changelog: "deprecated",
						publishedAt: 1,
						desktop: { hostProfileVersion: 1 },
						capabilities: [],
						artifacts: [
							{
								id: "status-1.0.0",
								target: { platform: "universal", arch: "universal" },
								sha256: "0".repeat(64),
								size: 1,
								downloadPath: "/status-1.0.0",
								containsNativeCode: false,
								preferred: true,
							},
						],
					},
				],
			},
		],
	};
}
