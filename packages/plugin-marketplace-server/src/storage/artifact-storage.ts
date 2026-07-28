import { Client } from "minio";
import type { MarketplaceServerConfig } from "../config.ts";

export interface ArtifactObject {
	bytes: Uint8Array;
	contentType: string;
}

export interface ArtifactStorage {
	ensureReady(): Promise<void>;
	put(objectKey: string, object: ArtifactObject): Promise<void>;
	get(objectKey: string, maximumBytes: number): Promise<Uint8Array | undefined>;
}

/** MinIO 只保存不可变制品正文；PostgreSQL 仅持有对象键与校验元数据。 */
export class MinioArtifactStorage implements ArtifactStorage {
	private readonly client: Client;
	private readonly bucket: string;
	private readonly region: string;

	constructor(config: MarketplaceServerConfig["artifactStorage"]) {
		this.client = new Client({
			endPoint: config.endPoint,
			port: config.port,
			useSSL: config.useSSL,
			accessKey: config.accessKey,
			secretKey: config.secretKey,
			region: config.region,
		});
		this.bucket = config.bucket;
		this.region = config.region;
	}

	async ensureReady(): Promise<void> {
		if (!(await this.client.bucketExists(this.bucket))) {
			await this.client.makeBucket(this.bucket, this.region);
		}
	}

	async put(objectKey: string, object: ArtifactObject): Promise<void> {
		await this.client.putObject(this.bucket, objectKey, Buffer.from(object.bytes), object.bytes.byteLength, {
			"Content-Type": object.contentType,
		});
	}

	async get(objectKey: string, maximumBytes: number): Promise<Uint8Array | undefined> {
		try {
			const stream = await this.client.getObject(this.bucket, objectKey);
			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of stream) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				total += bytes.byteLength;
				if (total > maximumBytes) throw new Error("Artifact object exceeds its configured size limit");
				chunks.push(bytes);
			}
			return Buffer.concat(chunks, total);
		} catch (error) {
			if (isMissingObject(error)) return undefined;
			throw error;
		}
	}
}

export class MemoryArtifactStorage implements ArtifactStorage {
	private readonly objects = new Map<string, Uint8Array>();

	async ensureReady(): Promise<void> {}

	async put(objectKey: string, object: ArtifactObject): Promise<void> {
		this.objects.set(objectKey, object.bytes.slice());
	}

	async get(objectKey: string, maximumBytes: number): Promise<Uint8Array | undefined> {
		const object = this.objects.get(objectKey);
		if (!object) return undefined;
		if (object.byteLength > maximumBytes) throw new Error("Artifact object exceeds its configured size limit");
		return object.slice();
	}
}

export function artifactObjectKey(sha256: string): string {
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Artifact SHA-256 is invalid");
	return `artifacts/sha256/${sha256.slice(0, 2)}/${sha256}.meta-plugin`;
}

function isMissingObject(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = "code" in error ? String(error.code) : "";
	return code === "NoSuchKey" || code === "NotFound" || code === "NoSuchObject";
}
