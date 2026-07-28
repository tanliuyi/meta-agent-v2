import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	NotFoundException,
	PayloadTooLargeException,
	UnauthorizedException,
	UnsupportedMediaTypeException,
} from "@nestjs/common";
import { hashToken, tokenEquals } from "./auth.ts";
import type { MarketplaceServerConfig } from "./config.ts";
import type { MarketplaceErrorBody } from "./contracts.ts";
import type { MarketplaceSigningService } from "./signing-service.ts";
import type { MarketplaceStore } from "./store.ts";

export type MarketplacePrincipal =
	| { kind: "admin" }
	| { kind: "user"; userId: number; username: string; createdAt: number };

export interface AuthRuntime {
	config: MarketplaceServerConfig;
	store: MarketplaceStore;
}

export interface MarketplaceHttpRuntime extends AuthRuntime {
	signing: MarketplaceSigningService;
	clock(): number;
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const PUBLISHER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const STORE_ERRORS: Record<
	string,
	{ status: "not-found" | "conflict" | "bad-request" | "payload-too-large"; message: string }
> = {
	PUBLISHER_NOT_FOUND: { status: "not-found", message: "Publisher not found" },
	USER_NOT_FOUND: { status: "not-found", message: "User not found" },
	PLUGIN_NOT_FOUND: { status: "not-found", message: "Plugin not found" },
	PLUGIN_VERSION_NOT_FOUND: { status: "not-found", message: "Plugin version not found" },
	PLUGIN_ARTIFACT_NOT_FOUND: { status: "not-found", message: "Plugin artifact not found" },
	USERNAME_TAKEN: { status: "conflict", message: "Username is already taken" },
	PLUGIN_PUBLISHER_MISMATCH: { status: "conflict", message: "Plugin belongs to a different publisher" },
	PLUGIN_VERSION_EXISTS: { status: "conflict", message: "Plugin version already exists" },
	PLUGIN_VERSION_NOT_DRAFT: { status: "conflict", message: "Plugin version is not an editable draft" },
	PLUGIN_VERSION_INCOMPLETE: { status: "conflict", message: "Plugin version has artifacts without uploaded content" },
	PLUGIN_VERSION_STATUS_INVALID: {
		status: "conflict",
		message: "Plugin version status does not allow this operation",
	},
	PAYLOAD_EMPTY: { status: "bad-request", message: "Artifact payload archive is empty" },
	PAYLOAD_ENTRY_MISSING: { status: "bad-request", message: "Declared entry file is missing from the payload archive" },
	PAYLOAD_INVALID_ARCHIVE: { status: "bad-request", message: "Artifact payload is not a valid zip archive" },
	PAYLOAD_INVALID_PATH: { status: "bad-request", message: "Artifact payload contains an unsafe file path" },
	PAYLOAD_DUPLICATE_PATH: { status: "bad-request", message: "Artifact payload contains duplicate file paths" },
	PAYLOAD_TOO_MANY_FILES: { status: "bad-request", message: "Artifact payload contains too many files" },
	PAYLOAD_NATIVE_UNSUPPORTED: {
		status: "bad-request",
		message: "Native modules and executable binaries are not supported yet",
	},
	PAYLOAD_TOO_LARGE: { status: "payload-too-large", message: "Artifact payload exceeds the size limit" },
};

export function errorBody(code: string, message: string): MarketplaceErrorBody {
	return { error: { code, message } };
}

export function badRequest(code: string, message: string): BadRequestException {
	return new BadRequestException(errorBody(code, message));
}

export function notFound(code: string, message: string): NotFoundException {
	return new NotFoundException(errorBody(code, message));
}

export function conflict(code: string, message: string): ConflictException {
	return new ConflictException(errorBody(code, message));
}

export function unauthorized(code: string, message: string): UnauthorizedException {
	return new UnauthorizedException(errorBody(code, message));
}

export function forbidden(code: string, message: string): ForbiddenException {
	return new ForbiddenException(errorBody(code, message));
}

export function payloadTooLarge(code: string, message: string): PayloadTooLargeException {
	return new PayloadTooLargeException(errorBody(code, message));
}

export function tooManyRequests(code: string, message: string): HttpException {
	return new HttpException(errorBody(code, message), 429);
}

export function unsupportedMediaType(code: string, message: string): UnsupportedMediaTypeException {
	return new UnsupportedMediaTypeException(errorBody(code, message));
}

export function storeErrorToHttp(error: unknown): HttpException | undefined {
	if (!(error instanceof Error)) return undefined;
	const mapped = STORE_ERRORS[error.message];
	if (!mapped) return undefined;
	switch (mapped.status) {
		case "not-found":
			return notFound(error.message, mapped.message);
		case "conflict":
			return conflict(error.message, mapped.message);
		case "bad-request":
			return badRequest(error.message, mapped.message);
		case "payload-too-large":
			return payloadTooLarge(error.message, mapped.message);
	}
}

export function mapStoreErrors<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		throw storeErrorToHttp(error) ?? error;
	}
}

// --- authentication ---

export function authenticate(
	runtime: AuthRuntime,
	authorization: string | undefined,
): MarketplacePrincipal | undefined {
	if (authorization === undefined) return undefined;
	const token = bearerToken(authorization);
	if (runtime.config.adminToken && tokenEquals(token, runtime.config.adminToken)) return { kind: "admin" };
	const session = runtime.store.getSessionUser(hashToken(token));
	if (!session) throw unauthorized("AUTH_INVALID", "Authorization token is invalid or expired");
	return { kind: "user", userId: session.userId, username: session.username, createdAt: session.createdAt };
}

export function bearerToken(authorization: string): string {
	if (!authorization.startsWith("Bearer ")) {
		throw unauthorized("AUTH_INVALID", "Authorization header must use the Bearer scheme");
	}
	const token = authorization.slice("Bearer ".length).trim();
	if (token.length === 0 || token.length > 512) {
		throw unauthorized("AUTH_INVALID", "Authorization token is malformed");
	}
	return token;
}

export function requirePrincipal(runtime: AuthRuntime, authorization: string | undefined): MarketplacePrincipal {
	const principal = authenticate(runtime, authorization);
	if (!principal) throw unauthorized("AUTH_REQUIRED", "Authorization is required");
	return principal;
}

export function requireUser(
	runtime: AuthRuntime,
	authorization: string | undefined,
): Extract<MarketplacePrincipal, { kind: "user" }> {
	const principal = requirePrincipal(runtime, authorization);
	if (principal.kind !== "user") {
		throw forbidden("USER_ACCOUNT_REQUIRED", "This operation requires a user account token");
	}
	return principal;
}

export function requireAdmin(runtime: AuthRuntime, authorization: string | undefined): void {
	if (!runtime.config.adminToken) {
		throw forbidden("ADMIN_DISABLED", "MARKETPLACE_ADMIN_TOKEN is not configured");
	}
	const principal = requirePrincipal(runtime, authorization);
	if (principal.kind !== "admin") {
		throw forbidden("ADMIN_REQUIRED", "This operation requires the marketplace admin token");
	}
}

// --- body validation ---

export function bodyObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw badRequest("BODY_INVALID", "Request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

export function bodyString(record: Record<string, unknown>, key: string, maxLength: number, minLength = 1): string {
	const value = record[key];
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		throw badRequest("BODY_INVALID", `${key} must be a string of ${minLength}..${maxLength} characters`);
	}
	return value;
}

export function bodyOptionalString(
	record: Record<string, unknown>,
	key: string,
	maxLength: number,
): string | undefined {
	if (record[key] === undefined) return undefined;
	return bodyString(record, key, maxLength);
}

export function bodyBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw badRequest("BODY_INVALID", `${key} must be a boolean`);
	return value;
}

export function bodyInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw badRequest("BODY_INVALID", `${key} must be an integer between ${minimum} and ${maximum}`);
	}
	return value as number;
}

export function bodyStringArray(
	record: Record<string, unknown>,
	key: string,
	maxItems: number,
	maxItemLength: number,
): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.length > maxItems) {
		throw badRequest("BODY_INVALID", `${key} must be an array of at most ${maxItems} strings`);
	}
	return value.map((item, index) => {
		if (typeof item !== "string" || item.length === 0 || item.length > maxItemLength) {
			throw badRequest("BODY_INVALID", `${key}[${index}] must be a string of 1..${maxItemLength} characters`);
		}
		return item;
	});
}

export function bodyArray(record: Record<string, unknown>, key: string, maxItems: number): unknown[] {
	const value = record[key];
	if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
		throw badRequest("BODY_INVALID", `${key} must be a non-empty array of at most ${maxItems} items`);
	}
	return value;
}

// --- raw upload bodies ---

export interface RawUploadRequest extends AsyncIterable<Uint8Array | string> {
	headers: Record<string, string | string[] | undefined>;
}

const UPLOAD_CONTENT_TYPES = new Set(["application/zip", "application/octet-stream"]);

export async function readUploadBody(request: RawUploadRequest, maxBytes: number): Promise<Uint8Array> {
	const contentTypeHeader = request.headers["content-type"];
	const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader)
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (!contentType || !UPLOAD_CONTENT_TYPES.has(contentType)) {
		throw unsupportedMediaType(
			"UPLOAD_CONTENT_TYPE_INVALID",
			"Artifact uploads must use application/zip or application/octet-stream",
		);
	}
	const declaredLength = request.headers["content-length"];
	const declared = Number(Array.isArray(declaredLength) ? declaredLength[0] : declaredLength);
	if (Number.isSafeInteger(declared) && declared > maxBytes) {
		throw payloadTooLarge("PAYLOAD_TOO_LARGE", "Artifact payload exceeds the size limit");
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > maxBytes) {
			throw payloadTooLarge("PAYLOAD_TOO_LARGE", "Artifact payload exceeds the size limit");
		}
		chunks.push(buffer);
	}
	if (total === 0) throw badRequest("PAYLOAD_EMPTY", "Artifact payload is empty");
	return Buffer.concat(chunks);
}
