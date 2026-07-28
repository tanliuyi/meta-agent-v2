import { createHash } from "node:crypto";
import { strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import type {
	ArtifactTarget,
	CatalogPluginVersion,
	MarketplaceArtifactManifest,
	MarketplaceArtifactSignature,
	PluginConfigurationSchema,
} from "./contracts.ts";
import { canonicalJson, type MarketplaceSigningService } from "./signing-service.ts";

export interface BuiltMarketplaceArtifact {
	bytes: Uint8Array;
	sha256: string;
	size: number;
	manifest: MarketplaceArtifactManifest;
	signature: MarketplaceArtifactSignature;
}

export interface ArtifactBuildInput {
	marketplaceId: string;
	artifactId: string;
	plugin: {
		id: string;
		name: string;
		version: string;
		publisherId: string;
	};
	entry: string;
	desktop: CatalogPluginVersion["desktop"];
	target: ArtifactTarget;
	configuration?: PluginConfigurationSchema;
	capabilities: string[];
	files: Map<string, Uint8Array>;
}

export const EXAMPLE_ENTRY_PATH = "index.ts";

const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const MAX_PAYLOAD_FILES = 1024;
const MAX_PAYLOAD_PATH_LENGTH = 256;

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

export function referencePayloadFiles(): Map<string, Uint8Array> {
	return new Map([[EXAMPLE_ENTRY_PATH, strToU8(EXAMPLE_ENTRY)]]);
}

export function buildSignedArtifact(
	signing: MarketplaceSigningService,
	input: ArtifactBuildInput,
): BuiltMarketplaceArtifact {
	if (input.files.size === 0) throw new Error("PAYLOAD_EMPTY");
	if (!input.files.has(input.entry)) throw new Error("PAYLOAD_ENTRY_MISSING");
	assertNoNativePayload(input.files);
	const files: MarketplaceArtifactManifest["files"] = {};
	for (const path of [...input.files.keys()].sort()) {
		const bytes = input.files.get(path)!;
		files[`payload/${path}`] = {
			sha256: sha256(bytes),
			size: bytes.byteLength,
			mode: "0644",
		};
	}
	const manifest: MarketplaceArtifactManifest = {
		schemaVersion: 1,
		marketplaceId: input.marketplaceId,
		artifactId: input.artifactId,
		plugin: { ...input.plugin },
		pi: {
			entry: `payload/${input.entry}`,
			extensionApi: "1",
		},
		desktop: { ...input.desktop },
		target: { ...input.target },
		...(input.configuration ? { configuration: structuredClone(input.configuration) } : {}),
		capabilities: [...input.capabilities],
		nativeModules: [],
		executables: [],
		files,
	};
	const signature = signing.envelope(manifest).signature;
	const archiveFiles: Zippable = {
		"market-manifest.json": zipFile(canonicalJson(manifest)),
		"signature.json": zipFile(`${JSON.stringify(signature, null, 2)}\n`),
	};
	for (const [path, bytes] of input.files) {
		archiveFiles[`payload/${path}`] = [bytes, fileOptions()];
	}
	const bytes = zipSync(archiveFiles, { level: 6, mtime: ZIP_MTIME, os: 3, attrs: 0o644 << 16 });
	return {
		bytes,
		sha256: sha256(bytes),
		size: bytes.byteLength,
		manifest,
		signature,
	};
}

export function extractPayloadArchive(bytes: Uint8Array, maxTotalBytes: number): Map<string, Uint8Array> {
	if (bytes.byteLength === 0) throw new Error("PAYLOAD_EMPTY");
	let fileCount = 0;
	let totalBytes = 0;
	let extracted: Record<string, Uint8Array>;
	try {
		extracted = unzipSync(bytes, {
			filter: (file) => {
				if (file.name.endsWith("/") && file.originalSize === 0) return false;
				fileCount += 1;
				if (fileCount > MAX_PAYLOAD_FILES) throw new Error("PAYLOAD_TOO_MANY_FILES");
				validatePayloadPath(file.name);
				totalBytes += file.originalSize;
				if (file.originalSize > maxTotalBytes || totalBytes > maxTotalBytes) {
					throw new Error("PAYLOAD_TOO_LARGE");
				}
				return true;
			},
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("PAYLOAD_")) throw error;
		throw new Error("PAYLOAD_INVALID_ARCHIVE");
	}
	const files = new Map<string, Uint8Array>();
	const normalized = new Set<string>();
	for (const [path, content] of Object.entries(extracted)) {
		const caseNormalized = path.toLowerCase();
		if (normalized.has(caseNormalized)) throw new Error("PAYLOAD_DUPLICATE_PATH");
		normalized.add(caseNormalized);
		files.set(path, content);
	}
	if (files.size === 0) throw new Error("PAYLOAD_EMPTY");
	assertNoNativePayload(files);
	return files;
}

export function validatePayloadPath(path: string): void {
	if (path.length === 0 || path.length > MAX_PAYLOAD_PATH_LENGTH) throw new Error("PAYLOAD_INVALID_PATH");
	if (path.startsWith("/") || path.endsWith("/")) throw new Error("PAYLOAD_INVALID_PATH");
	if (/\\|[\u0000-\u001f\u007f]/.test(path)) throw new Error("PAYLOAD_INVALID_PATH");
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") throw new Error("PAYLOAD_INVALID_PATH");
	}
}

export function assertNoNativePayload(files: ReadonlyMap<string, Uint8Array>): void {
	for (const [path, bytes] of files) {
		if (nativeFileName(path) || nativeBinaryMagic(bytes)) throw new Error("PAYLOAD_NATIVE_UNSUPPORTED");
	}
}

function nativeFileName(path: string): boolean {
	return /(?:^|\/)[^/]+\.(?:node|dll|exe|dylib|so(?:\.\d+)*)$/i.test(path);
}

function nativeBinaryMagic(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 4) return false;
	const magic = [bytes[0], bytes[1], bytes[2], bytes[3]].map((value) => value ?? 0).join(",");
	return (
		[
			"127,69,76,70",
			"77,90,0,0",
			"254,237,250,206",
			"254,237,250,207",
			"206,250,237,254",
			"207,250,237,254",
			"202,254,186,190",
			"202,254,186,191",
			"191,186,254,202",
			"190,186,254,202",
			"0,97,115,109",
		].includes(magic) ||
		(bytes[0] === 0x4d && bytes[1] === 0x5a)
	);
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
