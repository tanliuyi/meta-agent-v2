import type { Pool, PoolClient } from "pg";
import { buildArtifact, referencePayloadFiles } from "../artifact-builder.ts";
import type { CatalogDocument } from "../contracts.ts";
import type { QueryRunner } from "./query-runner.ts";

/** Advisory lock ID derived from the marketplace ID for concurrent startup safety. */
export function advisoryLockId(marketplaceId: string): number {
	let hash = 0;
	for (let index = 0; index < marketplaceId.length; index++) {
		hash = ((hash << 5) - hash + marketplaceId.charCodeAt(index)) | 0;
	}
	return Math.abs(hash);
}

export async function seedIfEmpty(pool: Pool, catalog: CatalogDocument, marketplaceId: string): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockId(marketplaceId)]);
		const seeded = await client.query("SELECT value FROM meta WHERE key = 'seeded'");
		if (seeded.rows.length === 0) {
			await seedCatalog(client, catalog, marketplaceId);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function seedCatalog(client: PoolClient, catalog: CatalogDocument, marketplaceId: string): Promise<void> {
	for (const plugin of catalog.plugins) {
		await upsertPublisherRow(client, plugin.publisher.id, plugin.publisher.displayName, plugin.publisher.verified);
		await client.query(
			"INSERT INTO plugins (id, name, description, publisher_id, categories, icon_asset_id, published_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
			[
				plugin.id,
				plugin.name,
				plugin.description,
				plugin.publisher.id,
				JSON.stringify(plugin.categories),
				plugin.iconAssetId ?? null,
				plugin.publishedAt,
				plugin.updatedAt,
			],
		);
		for (const version of plugin.versions) {
			await client.query(
				"INSERT INTO plugin_versions (plugin_id, version, status, draft, changelog, published_at, desktop, configuration, capabilities) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
				[
					plugin.id,
					version.version,
					version.status,
					false,
					version.changelog,
					version.publishedAt,
					JSON.stringify(version.desktop),
					version.configuration ? JSON.stringify(version.configuration) : null,
					JSON.stringify(version.capabilities),
				],
			);
			for (const artifact of version.artifacts) {
				const files = referencePayloadFiles();
				const entry = [...files.keys()][0]!;
				const built = buildArtifact({
					marketplaceId,
					artifactId: artifact.id,
					plugin: {
						id: plugin.id,
						name: plugin.name,
						version: version.version,
						publisherId: plugin.publisher.id,
					},
					entry,
					desktop: version.desktop,
					target: artifact.target,
					configuration: version.configuration,
					capabilities: version.capabilities,
					files,
				});
				await client.query(
					"INSERT INTO plugin_artifacts (plugin_id, version, artifact_id, target, contains_native_code, preferred, entry, sha256, size, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, decode($10, 'hex'))",
					[
						plugin.id,
						version.version,
						artifact.id,
						JSON.stringify(artifact.target),
						artifact.containsNativeCode,
						artifact.preferred,
						entry,
						built.sha256,
						built.size,
						Buffer.from(built.bytes).toString("hex"),
					],
				);
			}
		}
	}

	await client.query("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
}

async function upsertPublisherRow(
	db: QueryRunner,
	publisherId: string,
	displayName: string,
	verified: boolean,
): Promise<void> {
	await db.query(
		"INSERT INTO publishers (id, display_name, verified) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, verified = EXCLUDED.verified",
		[publisherId, displayName, verified],
	);
}
