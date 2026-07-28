import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
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
import { canonicalJson } from "../src/signing-service.ts";
import { dropTestSchema, testDatabaseUrl } from "./postgres-harness.ts";

const TEST_DB_URL = process.env.MARKETPLACE_TEST_DATABASE_URL;
const HTTP_SCHEMA = `http_${randomUUID().replaceAll("-", "")}`;
const TEST_SCHEMAS = new Set([HTTP_SCHEMA]);
const HTTP_DB_URL = TEST_DB_URL ? testDatabaseUrl(TEST_DB_URL, HTTP_SCHEMA) : undefined;

if (!TEST_DB_URL) {
	describe.skip("plugin marketplace HTTP API (requires MARKETPLACE_TEST_DATABASE_URL)", () => {
		it("placeholder", () => {});
	});
} else {
	interface EnvelopeBody {
		data: Record<string, unknown>;
		signature: { algorithm: string; keyId: string; value: string };
	}

	interface DiscoveryBody {
		protocolVersion: number;
		marketplaceId: string;
		apiRoot: string;
		artifactOrigins: string[];
		signing: { algorithm: string; keyId: string; fingerprint: string; publicKey: string };
	}

	interface ErrorBody {
		error: { code: string; message: string };
	}

	const privateKey = generateKeyPairSync("ed25519").privateKey;
	const config: MarketplaceServerConfig = {
		host: "127.0.0.1",
		port: 4317,
		basePath: "/market",
		publicBaseUrl: "https://market.example.com/market",
		marketplaceId: "test-marketplace",
		artifactOrigins: ["https://artifacts.example.com"],
		signingPrivateKey: privateKey,
		ephemeralSigningKey: false,
		databaseUrl: HTTP_DB_URL!,
		maxArtifactBytes: 32 * 1024 * 1024,
		allowRegistration: true,
		maxLoginFailures: 10,
		artifactStorage: {
			endPoint: "127.0.0.1",
			port: Number(process.env.MARKETPLACE_TEST_MINIO_PORT ?? "59000"),
			useSSL: false,
			accessKey: "marketplace-test",
			secretKey: "marketplace-test-secret",
			bucket: "marketplace-http-test",
			region: "us-east-1",
		},
		bootstrapAccounts: [],
	};

	let app: INestApplication;
	let clockNow = 1_800_000_000_000;

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
		await Promise.all([...TEST_SCHEMAS].map((schema) => dropTestSchema(TEST_DB_URL, schema)));
	});

	describe("plugin marketplace HTTP API", () => {
		it("serves health and trust-bootstrap discovery beneath the configured base path", async () => {
			await request(app.getHttpServer()).get("/market/health").expect(200, {
				status: "ok",
				marketplaceId: "test-marketplace",
				ephemeralSigningKey: false,
			});

			const response = await request(app.getHttpServer())
				.get("/market/.well-known/meta-agent-marketplace.json")
				.expect(200);
			const envelope = response.body as EnvelopeBody;
			const discovery = envelope.data as unknown as DiscoveryBody;
			expect(discovery).toMatchObject({
				protocolVersion: 1,
				marketplaceId: "test-marketplace",
				apiRoot: "https://market.example.com/market/v1",
				artifactOrigins: ["https://market.example.com", "https://artifacts.example.com"],
				signing: { algorithm: "ed25519" },
			});
			const publicKey = createPublicKey({
				key: Buffer.from(discovery.signing.publicKey, "base64"),
				format: "der",
				type: "spki",
			});
			expect(publicKey.asymmetricKeyType).toBe("ed25519");
			expect(signatureValid(envelope, publicKey)).toBe(true);
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

			const invalid = await request(app.getHttpServer())
				.get("/market/v1/plugins")
				.query({ limit: "101" })
				.expect(400);
			expect(invalid.body as ErrorBody).toEqual({
				error: { code: "QUERY_INVALID", message: "limit must be between 1 and 100" },
			});
		});

		it("keeps deprecated versions installable while refusing withdrawn and blocked artifacts", async () => {
			const directory = await mkdtemp(join(tmpdir(), "marketplace-status-http-"));
			const catalogPath = join(directory, "plugins.json");
			let statusApp: INestApplication | undefined;
			const statusSchema = `status_${randomUUID().replaceAll("-", "")}`;
			TEST_SCHEMAS.add(statusSchema);
			try {
				await writeFile(catalogPath, JSON.stringify(statusCatalog()), "utf8");
				statusApp = await createMarketplaceApp({
					config: {
						...config,
						databaseUrl: testDatabaseUrl(TEST_DB_URL, statusSchema),
					},
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
							latestVersion: "3.0.0",
							compatibleVersion: "1.0.0",
							status: "deprecated",
						},
					],
				});
				await request(server).get("/market/v1/plugins/status.plugin/versions/1.0.0/artifacts").expect(200);
				for (const version of ["2.0.0", "3.0.0"]) {
					const unavailable = await request(server)
						.get(`/market/v1/plugins/status.plugin/versions/${version}/artifacts`)
						.expect(410);
					expect(unavailable.body as ErrorBody).toMatchObject({
						error: { code: "PLUGIN_VERSION_UNAVAILABLE" },
					});
					await request(server).get(`/market/v1/artifacts/status.plugin/${version}/status-${version}`).expect(410);
				}
			} finally {
				await statusApp?.close();
				await rm(directory, { recursive: true, force: true });
				await dropTestSchema(TEST_DB_URL, statusSchema);
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
			const artifactMetadata = (artifacts.body as { artifacts: Array<{ sha256: string; size: number }> })
				.artifacts[0]!;
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
			expect(Object.keys(archive).sort()).toEqual(["market-manifest.json", "payload/index.ts", "signature.json"]);
			const manifest = JSON.parse(strFromU8(archive["market-manifest.json"]!)) as Record<string, unknown>;
			const signature = JSON.parse(strFromU8(archive["signature.json"]!)) as {
				algorithm: string;
				keyId: string;
				value: string;
			};
			expect(manifest).toMatchObject({
				schemaVersion: 1,
				marketplaceId: "test-marketplace",
				artifactId: "example-tools-1.0.0-universal",
				plugin: { id: "dev.meta-agent.example-tools", version: "1.0.0" },
				pi: { entry: "payload/index.ts" },
				nativeModules: [],
				executables: [],
			});
			expect(
				verify(
					null,
					Buffer.from(canonicalJson(manifest), "utf8"),
					createPublicKey(privateKey),
					Buffer.from(signature.value, "base64"),
				),
			).toBe(true);
		});

		it("returns stable not-found errors", async () => {
			const response = await request(app.getHttpServer()).get("/market/v1/plugins/missing.plugin").expect(404);
			expect(response.body as ErrorBody).toEqual({
				error: { code: "PLUGIN_NOT_FOUND", message: "Plugin not found: missing.plugin" },
			});
		});

		it("serves fresh signed revocation snapshots with restart-safe monotonic sequences", async () => {
			const response = await request(app.getHttpServer()).get("/market/v1/revocations").expect(200);
			const envelope = response.body as EnvelopeBody;
			expect(envelope.data).toEqual({
				marketplaceId: "test-marketplace",
				sequence: 1_800_000_000_000,
				issuedAt: 1_800_000_000_000,
				nextUpdateAt: 1_800_014_400_000,
				revokedKeys: [],
				pluginVersions: [],
			});
			expect(signatureValid(envelope)).toBe(true);

			clockNow += 1_000;
			const refreshed = await request(app.getHttpServer()).get("/market/v1/revocations").expect(200);
			expect(refreshed.body.data).toMatchObject({
				sequence: 1_800_000_001_000,
				issuedAt: 1_800_000_001_000,
				nextUpdateAt: 1_800_014_401_000,
			});
			expect(signatureValid(refreshed.body as EnvelopeBody)).toBe(true);

			clockNow += 1_000;
			const restarted = await createMarketplaceApp({
				config,
				clock: () => clockNow,
				logger: false,
			});
			try {
				await restarted.init();
				const afterRestart = await request(restarted.getHttpServer()).get("/market/v1/revocations").expect(200);
				expect((afterRestart.body as EnvelopeBody).data.sequence).toBeGreaterThan(
					(refreshed.body as EnvelopeBody).data.sequence as number,
				);
			} finally {
				await restarted.close();
			}
		});
	});

	function signatureValid(envelope: EnvelopeBody, publicKey = createPublicKey(privateKey)): boolean {
		return verify(
			null,
			Buffer.from(canonicalJson(envelope.data), "utf8"),
			publicKey,
			Buffer.from(envelope.signature.value, "base64"),
		);
	}

	function statusCatalog() {
		const versions = [
			{ version: "1.0.0", status: "deprecated" },
			{ version: "2.0.0", status: "withdrawn" },
			{ version: "3.0.0", status: "blocked" },
		] as const;
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
					updatedAt: 3,
					versions: versions.map(({ version, status }, index) => ({
						version,
						status,
						changelog: status,
						publishedAt: index + 1,
						desktop: { hostProfileVersion: 1 },
						capabilities: [],
						artifacts: [
							{
								id: `status-${version}`,
								target: { platform: "universal", arch: "universal" },
								sha256: String(index).repeat(64),
								size: 1,
								downloadPath: `/status-${version}`,
								containsNativeCode: false,
								preferred: true,
							},
						],
					})),
				},
			],
			revocations: [],
		};
	}
}
