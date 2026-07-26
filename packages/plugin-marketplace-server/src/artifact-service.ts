import { createHash } from "node:crypto";
import { strToU8, type Zippable, zipSync } from "fflate";
import type { CatalogRepository } from "./catalog-repository.ts";
import type {
	ArtifactTarget,
	CatalogArtifact,
	CatalogPluginVersion,
	MarketplaceArtifactManifest,
	MarketplaceArtifactSignature,
} from "./contracts.ts";
import { canonicalJson, type MarketplaceSigningService } from "./signing-service.ts";

export interface GeneratedMarketplaceArtifact {
	pluginId: string;
	version: string;
	artifactId: string;
	bytes: Uint8Array;
	sha256: string;
	size: number;
	manifest: MarketplaceArtifactManifest;
	signature: MarketplaceArtifactSignature;
}

const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);

const EXAMPLE_ENTRY = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function marketplaceExample(pi: ExtensionAPI): void {
\tpi.registerCommand("marketplace-example", {
\t\tdescription: "Verify the example marketplace extension is loaded",
\t\thandler: async (_args, ctx) => {
\t\t\tctx.ui.notify("Marketplace example extension is active", "info");
\t\t},
\t});
}
`;

export class MarketplaceArtifactService {
	private readonly repository: CatalogRepository;
	private readonly signing: MarketplaceSigningService;
	private readonly marketplaceId: string;
	private readonly cache = new Map<string, GeneratedMarketplaceArtifact>();

	constructor(repository: CatalogRepository, signing: MarketplaceSigningService, marketplaceId: string) {
		this.repository = repository;
		this.signing = signing;
		this.marketplaceId = marketplaceId;
	}

	get(pluginId: string, version: string, artifactId: string): GeneratedMarketplaceArtifact | undefined {
		const key = `${pluginId}\0${version}\0${artifactId}`;
		const cached = this.cache.get(key);
		if (cached) return cloneGeneratedArtifact(cached);
		const plugin = this.repository.getPlugin(pluginId);
		const pluginVersion = this.repository.getVersion(pluginId, version);
		const catalogArtifact = this.repository.getArtifact(pluginId, version, artifactId);
		if (!plugin || !pluginVersion || !catalogArtifact) return undefined;
		const generated = this.generate(plugin.name, plugin.publisher.id, pluginVersion, catalogArtifact, pluginId);
		this.cache.set(key, generated);
		return cloneGeneratedArtifact(generated);
	}

	private generate(
		pluginName: string,
		publisherId: string,
		pluginVersion: CatalogPluginVersion,
		catalogArtifact: CatalogArtifact,
		pluginId: string,
	): GeneratedMarketplaceArtifact {
		const entryPath = "payload/index.ts";
		const entryBytes = strToU8(EXAMPLE_ENTRY);
		const manifest: MarketplaceArtifactManifest = {
			schemaVersion: 1,
			marketplaceId: this.marketplaceId,
			artifactId: catalogArtifact.id,
			plugin: {
				id: pluginId,
				name: pluginName,
				version: pluginVersion.version,
				publisherId,
			},
			pi: {
				entry: entryPath,
				extensionApi: "1",
			},
			desktop: { ...pluginVersion.desktop },
			target: cloneTarget(catalogArtifact.target),
			capabilities: [...pluginVersion.capabilities],
			nativeModules: [],
			executables: [],
			files: {
				[entryPath]: {
					sha256: sha256(entryBytes),
					size: entryBytes.byteLength,
					mode: "0644",
				},
			},
		};
		const signature = this.signing.envelope(manifest).signature;
		const archiveFiles: Zippable = {
			"market-manifest.json": zipFile(canonicalJson(manifest)),
			"signature.json": zipFile(`${JSON.stringify(signature, null, 2)}\n`),
			[entryPath]: [entryBytes, fileOptions()],
		};
		const bytes = zipSync(archiveFiles, { level: 6, mtime: ZIP_MTIME, os: 3, attrs: 0o644 << 16 });
		return {
			pluginId,
			version: pluginVersion.version,
			artifactId: catalogArtifact.id,
			bytes,
			sha256: sha256(bytes),
			size: bytes.byteLength,
			manifest,
			signature,
		};
	}
}

function zipFile(source: string): [Uint8Array, ReturnType<typeof fileOptions>] {
	return [strToU8(source), fileOptions()];
}

function fileOptions() {
	return { level: 6 as const, mtime: ZIP_MTIME, os: 3, attrs: 0o644 << 16 };
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function cloneTarget(target: ArtifactTarget): ArtifactTarget {
	return { ...target };
}

function cloneGeneratedArtifact(artifact: GeneratedMarketplaceArtifact): GeneratedMarketplaceArtifact {
	return {
		...artifact,
		bytes: artifact.bytes.slice(),
		manifest: {
			...artifact.manifest,
			plugin: { ...artifact.manifest.plugin },
			pi: { ...artifact.manifest.pi },
			desktop: { ...artifact.manifest.desktop },
			target: { ...artifact.manifest.target },
			capabilities: [...artifact.manifest.capabilities],
			nativeModules: artifact.manifest.nativeModules.map((entry) => ({ ...entry, abi: { ...entry.abi } })),
			executables: artifact.manifest.executables.map((entry) => ({ ...entry })),
			files: Object.fromEntries(Object.entries(artifact.manifest.files).map(([path, file]) => [path, { ...file }])),
		},
		signature: { ...artifact.signature },
	};
}
