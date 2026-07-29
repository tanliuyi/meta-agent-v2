import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNoNativePayload } from "../src/artifact-builder.ts";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../src/auth.ts";
import type { MarketplaceServerConfig } from "../src/config.ts";
import { createMarketplaceApp } from "../src/create-app.ts";

const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
const config: MarketplaceServerConfig = {
	host: "127.0.0.1",
	port: 4317,
	basePath: "",
	publicBaseUrl: "https://market.example.com",
	marketplaceId: "test-marketplace",
	adminToken: ADMIN_TOKEN,
	maxArtifactBytes: 1024 * 1024,
	allowRegistration: true,
	maxLoginFailures: 10,
};

const PLUGIN_ID = "com.acme.tools";
const ARTIFACT_ID = "tools-universal";
const ENTRY_SOURCE = "export default function acmeTools(): void {\n\t// marketplace upload fixture\n}\n";
const HELPER_SOURCE = "export const helper = true;\n";

let app: INestApplication;
let aliceToken = "";
let bobToken = "";

beforeAll(async () => {
	app = await createMarketplaceApp({ config, clock: () => 1_800_000_000_000, logger: false });
	await app.init();
	aliceToken = await register("alice");
	bobToken = await register("bob");
});

afterAll(async () => {
	await app.close();
});

describe("accounts and sessions", () => {
	it("registers, logs in, and revokes sessions", async () => {
		const me = await request(app.getHttpServer())
			.get("/v1/auth/me")
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		expect(me.body).toEqual({
			admin: false,
			user: { username: "alice", createdAt: 1_800_000_000_000 },
			publisherIds: [],
		});

		const duplicate = await request(app.getHttpServer())
			.post("/v1/auth/register")
			.send({ username: "alice", password: "password123" })
			.expect(409);
		expect(duplicate.body).toEqual({
			error: { code: "USERNAME_TAKEN", message: "Username is already taken" },
		});
		await request(app.getHttpServer())
			.post("/v1/auth/register")
			.send({ username: "Invalid Name", password: "password123" })
			.expect(400);
		const wrongPassword = await request(app.getHttpServer())
			.post("/v1/auth/login")
			.send({ username: "alice", password: "wrong-password" })
			.expect(401);
		const unknownUser = await request(app.getHttpServer())
			.post("/v1/auth/login")
			.send({ username: "no-such-user", password: "password123" })
			.expect(401);
		expect(unknownUser.body).toEqual(wrongPassword.body);
		expect(unknownUser.body).toEqual({
			error: { code: "AUTH_INVALID", message: "Invalid username or password" },
		});

		const login = await request(app.getHttpServer())
			.post("/v1/auth/login")
			.send({ username: "alice", password: "password123" })
			.expect(200);
		const sessionToken = (login.body as { token: string }).token;
		await request(app.getHttpServer())
			.post("/v1/auth/logout")
			.set("authorization", `Bearer ${sessionToken}`)
			.expect(204);
		await request(app.getHttpServer()).get("/v1/auth/me").set("authorization", `Bearer ${sessionToken}`).expect(401);
	});

	it("identifies the admin token without a user account", async () => {
		const me = await request(app.getHttpServer())
			.get("/v1/auth/me")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.expect(200);
		expect(me.body).toEqual({ admin: true, publisherIds: [] });
	});

	it("hashes and verifies passwords asynchronously in the stored scrypt format", async () => {
		const stored = await hashPassword("password123");
		expect(stored).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
		await expect(verifyPassword("password123", stored)).resolves.toBe(true);
		await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
		expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
		await expect(verifyPassword("password123", DUMMY_PASSWORD_HASH)).resolves.toBe(false);
	});

	it("throttles failed logins per client and resets on success", async () => {
		let now = 1_800_000_000_000;
		const limited = await createMarketplaceApp({
			config: { ...config, maxLoginFailures: 2 },
			clock: () => now,
			logger: false,
		});
		await limited.init();
		try {
			await registerOn(limited, "dave");
			const wrong = { username: "dave", password: "wrong-password" };
			const right = { username: "dave", password: "password123" };
			await request(limited.getHttpServer()).post("/v1/auth/login").send(wrong).expect(401);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(wrong).expect(401);
			const blocked = await request(limited.getHttpServer()).post("/v1/auth/login").send(right).expect(429);
			expect(blocked.body).toEqual({
				error: { code: "AUTH_RATE_LIMITED", message: "Too many failed login attempts; try again later" },
			});

			now += 15 * 60 * 1000;
			await request(limited.getHttpServer()).post("/v1/auth/login").send(right).expect(200);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(wrong).expect(401);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(right).expect(200);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(wrong).expect(401);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(wrong).expect(401);
			await request(limited.getHttpServer()).post("/v1/auth/login").send(right).expect(429);
		} finally {
			await limited.close();
		}
	});
});

describe("artifact native-code policy", () => {
	it.each([
		["ELF", [0x7f, 0x45, 0x4c, 0x46]],
		["PE", [0x4d, 0x5a, 0, 0]],
		["Mach-O FAT", [0xca, 0xfe, 0xba, 0xbe]],
		["Mach-O FAT64", [0xca, 0xfe, 0xba, 0xbf]],
		["Mach-O FAT64 reversed", [0xbf, 0xba, 0xfe, 0xca]],
		["Mach-O FAT reversed", [0xbe, 0xba, 0xfe, 0xca]],
		["WebAssembly", [0, 0x61, 0x73, 0x6d]],
	] as const)("rejects %s magic without relying on the filename", (_label, magic) => {
		expect(() => assertNoNativePayload(new Map([["payload/addon.dat", new Uint8Array(magic)]]))).toThrow(
			"PAYLOAD_NATIVE_UNSUPPORTED",
		);
	});
});

describe("publisher administration", () => {
	it("restricts publisher management to the admin token", async () => {
		await request(app.getHttpServer()).get("/v1/admin/publishers").expect(401);
		await request(app.getHttpServer())
			.get("/v1/admin/publishers")
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(403);

		const created = await request(app.getHttpServer())
			.put("/v1/admin/publishers/acme")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.send({ displayName: "Acme Publishing", verified: true })
			.expect(200);
		expect(created.body).toEqual({
			publisher: { id: "acme", displayName: "Acme Publishing", verified: true, members: [] },
		});

		await request(app.getHttpServer())
			.put("/v1/admin/publishers/acme/members/alice")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.expect(204);
		await request(app.getHttpServer())
			.put("/v1/admin/publishers/acme/members/missing-user")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.expect(404);

		const publishers = await request(app.getHttpServer())
			.get("/v1/admin/publishers")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.expect(200);
		expect(publishers.body).toEqual({
			publishers: [
				{ id: "acme", displayName: "Acme Publishing", verified: true, members: ["alice"] },
				{ id: "meta-agent", displayName: "Meta Agent", verified: true, members: [] },
			],
		});

		const me = await request(app.getHttpServer())
			.get("/v1/auth/me")
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		expect((me.body as { publisherIds: string[] }).publisherIds).toEqual(["acme"]);
	});
});

describe("publishing", () => {
	it("publishes an uploaded plugin version end to end", async () => {
		await request(app.getHttpServer()).put(`/v1/publish/plugins/${PLUGIN_ID}`).send(pluginMetadata()).expect(401);
		await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}`)
			.set("authorization", `Bearer ${bobToken}`)
			.send(pluginMetadata())
			.expect(403);

		await request(app.getHttpServer()).get("/v1/publish/plugins").expect(401);
		const unauthorizedList = await request(app.getHttpServer())
			.get("/v1/publish/plugins")
			.set("authorization", `Bearer ${bobToken}`)
			.expect(200);
		expect(unauthorizedList.body).toEqual({ plugins: [] });

		const created = await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send(pluginMetadata())
			.expect(200);
		expect(created.body).toEqual({
			plugin: {
				id: PLUGIN_ID,
				name: "Acme Tools",
				description: "Automation helpers published by Acme.",
				publisherId: "acme",
				categories: ["productivity"],
				versions: [],
			},
		});
		const ownPlugins = await request(app.getHttpServer())
			.get("/v1/publish/plugins")
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		expect(ownPlugins.body).toEqual({ plugins: [created.body.plugin] });
		const adminPlugins = await request(app.getHttpServer())
			.get("/v1/publish/plugins")
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.expect(200);
		expect((adminPlugins.body as { plugins: Array<{ id: string }> }).plugins.map(({ id }) => id)).toEqual([
			PLUGIN_ID,
			"dev.meta-agent.example-tools",
		]);

		const nativeDeclaration = versionDeclaration("0.9.0");
		nativeDeclaration.artifacts[0]!.containsNativeCode = true;
		const rejectedNativeDeclaration = await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send(nativeDeclaration)
			.expect(400);
		expect(rejectedNativeDeclaration.body).toMatchObject({
			error: { code: "NATIVE_ARTIFACT_UNSUPPORTED" },
		});

		const missingConfigurationCapability = versionDeclaration("0.9.1");
		missingConfigurationCapability.capabilities = ["tools.register"];
		const rejectedConfigurationCapability = await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send(missingConfigurationCapability)
			.expect(400);
		expect(rejectedConfigurationCapability.body).toMatchObject({
			error: { code: "BODY_INVALID", message: "configuration requires the configuration.read capability" },
		});

		const draft = await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send(versionDeclaration("1.0.0"))
			.expect(201);
		expect(draft.body).toEqual({
			pluginId: PLUGIN_ID,
			version: {
				version: "1.0.0",
				status: "available",
				draft: true,
				artifacts: [{ id: ARTIFACT_ID, uploaded: false }],
			},
		});

		await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}`).expect(404);
		const listBefore = await request(app.getHttpServer())
			.get("/v1/plugins")
			.query({ includeIncompatible: "true", limit: "50" })
			.expect(200);
		expect((listBefore.body as { plugins: Array<{ id: string }> }).plugins.some(({ id }) => id === PLUGIN_ID)).toBe(
			false,
		);

		await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/publish`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(409);

		await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "text/plain")
			.send("not-a-zip")
			.expect(415);
		await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(Buffer.from(zipSync({ "../escape.ts": strToU8(ENTRY_SOURCE) })))
			.expect(400);
		await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(Buffer.from(zipSync({ "other.ts": strToU8(HELPER_SOURCE) })))
			.expect(400);
		await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(Buffer.from(zipSync({ "index.ts": strToU8(ENTRY_SOURCE), "lib/": strToU8(HELPER_SOURCE) })))
			.expect(400);
		const rejectedNativeName = await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(
				Buffer.from(
					zipSync({ "index.ts": strToU8(ENTRY_SOURCE), "native/addon.node": new Uint8Array([0, 0, 0, 0]) }),
				),
			)
			.expect(400);
		expect(rejectedNativeName.body).toMatchObject({ error: { code: "PAYLOAD_NATIVE_UNSUPPORTED" } });
		const rejectedNativeMagic = await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(
				Buffer.from(
					zipSync({ "index.ts": strToU8(ENTRY_SOURCE), "native/addon.dat": new Uint8Array([0x4d, 0x5a, 0, 0]) }),
				),
			)
			.expect(400);
		expect(rejectedNativeMagic.body).toMatchObject({ error: { code: "PAYLOAD_NATIVE_UNSUPPORTED" } });

		const uploaded = await request(app.getHttpServer())
			.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.set("content-type", "application/zip")
			.send(Buffer.from(payloadArchive()))
			.expect(200);
		const uploadBody = uploaded.body as { sha256: string; size: number };
		expect(uploadBody.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(uploadBody.size).toBeGreaterThan(0);

		const published = await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/publish`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		expect(published.body).toMatchObject({
			pluginId: PLUGIN_ID,
			version: {
				version: "1.0.0",
				status: "available",
				publishedAt: 1_800_000_000_000,
				artifacts: [{ id: ARTIFACT_ID, sha256: uploadBody.sha256, size: uploadBody.size }],
			},
		});

		const detail = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}`).expect(200);
		expect(detail.body).toMatchObject({
			id: PLUGIN_ID,
			latestVersion: "1.0.0",
			publisher: { id: "acme", displayName: "Acme Publishing", verified: true },
			rating: { count: 0, average: null },
			downloadCount: 0,
		});

		const state = await request(app.getHttpServer())
			.get(`/v1/publish/plugins/${PLUGIN_ID}`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		expect(state.body).toMatchObject({
			plugin: { versions: [{ version: "1.0.0", draft: false, artifacts: [{ uploaded: true }] }] },
		});
	});

	it("serves uploaded artifacts and tracks download counts", async () => {
		const download = await request(app.getHttpServer())
			.get(`/v1/plugins/${PLUGIN_ID}/versions/1.0.0/artifacts/${ARTIFACT_ID}/download`)
			.expect(200);
		const downloadBody = download.body as { url: string; sha256: string; size: number };
		expect(downloadBody.url).toBe(`https://market.example.com/v1/artifacts/${PLUGIN_ID}/1.0.0/${ARTIFACT_ID}`);

		const bytesResponse = await request(app.getHttpServer())
			.get(`/v1/artifacts/${PLUGIN_ID}/1.0.0/${ARTIFACT_ID}`)
			.buffer(true)
			.parse((response, callback) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => callback(null, Buffer.concat(chunks)));
				response.on("error", (error: Error) => callback(error, Buffer.alloc(0)));
			})
			.expect(200);
		const bytes = bytesResponse.body as Buffer;
		expect(bytes.byteLength).toBe(downloadBody.size);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(downloadBody.sha256);

		const archive = unzipSync(bytes);
		expect(Object.keys(archive).sort()).toEqual([
			"market-manifest.json",
			"payload/index.ts",
			"payload/lib/helper.ts",
		]);
		expect(strFromU8(archive["payload/index.ts"]!)).toBe(ENTRY_SOURCE);
		const manifest = JSON.parse(strFromU8(archive["market-manifest.json"]!)) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			schemaVersion: 1,
			marketplaceId: "test-marketplace",
			artifactId: ARTIFACT_ID,
			plugin: { id: PLUGIN_ID, name: "Acme Tools", version: "1.0.0", publisherId: "acme" },
			pi: { entry: "payload/index.ts" },
			configuration: {
				version: 1,
				fields: [
					{
						key: "endpoint",
						label: "Endpoint",
						type: "text",
						required: true,
						defaultValue: "https://example.test",
					},
				],
			},
			files: {
				"payload/index.ts": {
					mode: "0644",
				},
			},
		});

		const stats = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/stats`).expect(200);
		expect(stats.body).toEqual({
			downloadCount: 1,
			downloadsByVersion: { "1.0.0": 1 },
			rating: { count: 0, average: null },
		});

		await request(app.getHttpServer()).get(`/v1/artifacts/${PLUGIN_ID}/1.0.0/${ARTIFACT_ID}`).expect(200);
		const refreshed = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/stats`).expect(200);
		expect((refreshed.body as { downloadCount: number }).downloadCount).toBe(2);

		await request(app.getHttpServer()).head(`/v1/artifacts/${PLUGIN_ID}/1.0.0/${ARTIFACT_ID}`).expect(200);
		const afterHead = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/stats`).expect(200);
		expect((afterHead.body as { downloadCount: number }).downloadCount).toBe(2);
	});

	it("manages draft deletion and deprecation", async () => {
		await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send(versionDeclaration("1.1.0"))
			.expect(201);
		await request(app.getHttpServer())
			.delete(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.1.0`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(204);
		await request(app.getHttpServer())
			.delete(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.1.0`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(404);

		await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/deprecate`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(200);
		const version = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/versions/1.0.0`).expect(200);
		expect((version.body as { status: string }).status).toBe("deprecated");
		await request(app.getHttpServer())
			.post(`/v1/publish/plugins/${PLUGIN_ID}/versions/1.0.0/deprecate`)
			.set("authorization", `Bearer ${aliceToken}`)
			.expect(409);
	});

	it("orders version lists by semver precedence, not string order", async () => {
		for (const version of ["1.9.0", "1.10.0"]) {
			await request(app.getHttpServer())
				.post(`/v1/publish/plugins/${PLUGIN_ID}/versions`)
				.set("authorization", `Bearer ${aliceToken}`)
				.send(versionDeclaration(version))
				.expect(201);
			await request(app.getHttpServer())
				.put(`/v1/publish/plugins/${PLUGIN_ID}/versions/${version}/artifacts/${ARTIFACT_ID}`)
				.set("authorization", `Bearer ${aliceToken}`)
				.set("content-type", "application/zip")
				.send(Buffer.from(payloadArchive()))
				.expect(200);
			await request(app.getHttpServer())
				.post(`/v1/publish/plugins/${PLUGIN_ID}/versions/${version}/publish`)
				.set("authorization", `Bearer ${aliceToken}`)
				.expect(200);
		}

		const versions = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/versions`).expect(200);
		expect((versions.body as Array<{ version: string }>).map(({ version }) => version)).toEqual([
			"1.0.0",
			"1.9.0",
			"1.10.0",
		]);
		const detail = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}`).expect(200);
		expect((detail.body as { latestVersion: string }).latestVersion).toBe("1.10.0");
	});
});

describe("ratings", () => {
	it("collects per-user ratings with aggregates", async () => {
		await request(app.getHttpServer()).put(`/v1/plugins/${PLUGIN_ID}/rating`).send({ stars: 5 }).expect(401);
		await request(app.getHttpServer())
			.put(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${ADMIN_TOKEN}`)
			.send({ stars: 5 })
			.expect(403);
		await request(app.getHttpServer())
			.put(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send({ stars: 6 })
			.expect(400);

		const first = await request(app.getHttpServer())
			.put(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send({ stars: 5, review: "Excellent tools" })
			.expect(200);
		expect(first.body).toEqual({ rating: { count: 1, average: 5 } });

		await request(app.getHttpServer())
			.put(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${bobToken}`)
			.send({ stars: 4 })
			.expect(200);
		const updated = await request(app.getHttpServer())
			.put(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${aliceToken}`)
			.send({ stars: 3, review: "Still good" })
			.expect(200);
		expect(updated.body).toEqual({ rating: { count: 2, average: 3.5 } });

		const ratings = await request(app.getHttpServer()).get(`/v1/plugins/${PLUGIN_ID}/ratings`).expect(200);
		expect(ratings.body).toMatchObject({
			rating: { count: 2, average: 3.5 },
			histogram: [0, 0, 1, 1, 0],
		});
		expect(
			(ratings.body as { ratings: Array<{ username: string }> }).ratings.map(({ username }) => username).sort(),
		).toEqual(["alice", "bob"]);

		await request(app.getHttpServer())
			.delete(`/v1/plugins/${PLUGIN_ID}/rating`)
			.set("authorization", `Bearer ${bobToken}`)
			.expect(204);
		const summary = await request(app.getHttpServer())
			.get("/v1/plugins")
			.query({ includeIncompatible: "true", limit: "50" })
			.expect(200);
		const entry = (summary.body as { plugins: Array<Record<string, unknown>> }).plugins.find(
			({ id }) => id === PLUGIN_ID,
		);
		expect(entry).toMatchObject({ rating: { count: 1, average: 3 }, downloadCount: 2 });
	});
});

describe("persistence", () => {
	it("retains accounts, plugins, ratings, and stats across restarts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "marketplace-persist-"));
		const persistentConfig: MarketplaceServerConfig = { ...config, dataDir: join(directory, "data") };
		try {
			const first = await createMarketplaceApp({
				config: persistentConfig,
				clock: () => 1_800_000_000_000,
				logger: false,
			});
			await first.init();
			const token = await registerOn(first, "carol");
			await request(first.getHttpServer())
				.put("/v1/admin/publishers/persist-pub")
				.set("authorization", `Bearer ${ADMIN_TOKEN}`)
				.send({ displayName: "Persistent Publisher", verified: false })
				.expect(200);
			await request(first.getHttpServer())
				.put("/v1/admin/publishers/persist-pub/members/carol")
				.set("authorization", `Bearer ${ADMIN_TOKEN}`)
				.expect(204);
			await request(first.getHttpServer())
				.put("/v1/publish/plugins/dev.persist.demo")
				.set("authorization", `Bearer ${token}`)
				.send({
					name: "Persistence Demo",
					description: "Plugin stored in SQLite",
					publisherId: "persist-pub",
					categories: ["test"],
				})
				.expect(200);
			await request(first.getHttpServer())
				.post("/v1/publish/plugins/dev.persist.demo/versions")
				.set("authorization", `Bearer ${token}`)
				.send(versionDeclaration("2.0.0"))
				.expect(201);
			await request(first.getHttpServer())
				.put(`/v1/publish/plugins/dev.persist.demo/versions/2.0.0/artifacts/${ARTIFACT_ID}`)
				.set("authorization", `Bearer ${token}`)
				.set("content-type", "application/zip")
				.send(Buffer.from(payloadArchive()))
				.expect(200);
			await request(first.getHttpServer())
				.post("/v1/publish/plugins/dev.persist.demo/versions/2.0.0/publish")
				.set("authorization", `Bearer ${token}`)
				.expect(200);
			await request(first.getHttpServer())
				.put("/v1/plugins/dev.persist.demo/rating")
				.set("authorization", `Bearer ${token}`)
				.send({ stars: 4 })
				.expect(200);
			await request(first.getHttpServer()).get(`/v1/artifacts/dev.persist.demo/2.0.0/${ARTIFACT_ID}`).expect(200);
			await first.close();

			const second = await createMarketplaceApp({
				config: persistentConfig,
				clock: () => 1_800_000_100_000,
				logger: false,
			});
			await second.init();
			try {
				const login = await request(second.getHttpServer())
					.post("/v1/auth/login")
					.send({ username: "carol", password: "password123" })
					.expect(200);
				expect((login.body as { token: string }).token).toMatch(/^mkt_/);
				const detail = await request(second.getHttpServer()).get("/v1/plugins/dev.persist.demo").expect(200);
				expect(detail.body).toMatchObject({
					latestVersion: "2.0.0",
					rating: { count: 1, average: 4 },
					downloadCount: 1,
				});
				const list = await request(second.getHttpServer())
					.get("/v1/plugins")
					.query({ includeIncompatible: "true", limit: "50" })
					.expect(200);
				const seeded = (list.body as { plugins: Array<{ id: string }> }).plugins.filter(
					({ id }) => id === "dev.meta-agent.example-tools",
				);
				expect(seeded).toHaveLength(1);
			} finally {
				await second.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

async function register(username: string): Promise<string> {
	return registerOn(app, username);
}

async function registerOn(target: INestApplication, username: string): Promise<string> {
	const response = await request(target.getHttpServer())
		.post("/v1/auth/register")
		.send({ username, password: "password123" })
		.expect(201);
	const body = response.body as { token: string; expiresAt: number; user: { username: string } };
	expect(body.token).toMatch(/^mkt_/);
	expect(body.user.username).toBe(username);
	return body.token;
}

function pluginMetadata() {
	return {
		name: "Acme Tools",
		description: "Automation helpers published by Acme.",
		publisherId: "acme",
		categories: ["productivity"],
	};
}

function versionDeclaration(version: string) {
	return {
		version,
		changelog: "Test release",
		desktop: { hostProfileVersion: 1 },
		capabilities: ["tools.register", "configuration.read"],
		configuration: {
			version: 1,
			fields: [
				{
					key: "endpoint",
					label: "Endpoint",
					type: "text",
					required: true,
					defaultValue: "https://example.test",
				},
			],
		},
		artifacts: [
			{
				id: ARTIFACT_ID,
				target: { platform: "universal", arch: "universal" },
				entry: "index.ts",
				containsNativeCode: false,
				preferred: true,
			},
		],
	};
}

function payloadArchive(): Uint8Array {
	// The zero-length "lib/" entry mirrors the directory entries written by zip -r,
	// Finder, Windows Explorer, and shutil.make_archive; uploads must tolerate them.
	return zipSync({
		"index.ts": strToU8(ENTRY_SOURCE),
		"lib/": new Uint8Array(0),
		"lib/helper.ts": strToU8(HELPER_SOURCE),
	});
}
