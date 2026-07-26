import { createHash, createPublicKey, type KeyObject, sign } from "node:crypto";
import type { SignedEnvelope } from "./contracts.ts";

export class MarketplaceSigningService {
	readonly keyId: string;
	readonly fingerprint: string;
	readonly publicKey: string;
	private readonly privateKey: KeyObject;

	constructor(privateKey: KeyObject) {
		if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
			throw new Error("Marketplace signing requires an Ed25519 private key");
		}
		this.privateKey = privateKey;
		const publicKey = createPublicKey(privateKey);
		const der = publicKey.export({ type: "spki", format: "der" });
		const digest = createHash("sha256").update(der).digest("hex");
		this.keyId = `ed25519:${digest.slice(0, 16)}`;
		this.fingerprint = `sha256:${digest}`;
		this.publicKey = der.toString("base64");
	}

	envelope<T>(data: T): SignedEnvelope<T> {
		const bytes = Buffer.from(canonicalJson(data), "utf8");
		return {
			data,
			signature: {
				algorithm: "ed25519",
				keyId: this.keyId,
				value: sign(null, bytes, this.privateKey).toString("base64"),
			},
		};
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		result[key] = canonicalValue(record[key]);
	}
	return result;
}
