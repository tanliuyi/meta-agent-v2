import { Body, Headers, Req, type Type } from "@nestjs/common";
import {
	DUMMY_PASSWORD_HASH,
	generateSessionToken,
	hashPassword,
	hashToken,
	SESSION_TTL_MS,
	verifyPassword,
} from "../auth.ts";
import type { AuthMeResponse, AuthSessionResponse } from "../contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import {
	badRequest,
	bearerToken,
	bodyObject,
	bodyString,
	forbidden,
	type MarketplaceHttpRuntime,
	mapStoreErrorsAsync,
	requirePrincipal,
	tooManyRequests,
	USERNAME_PATTERN,
	unauthorized,
} from "./http-util.ts";

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

interface LoginRequestLike {
	ip?: string;
}

export function createAuthControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	const loginFailures = new Map<string, { count: number; windowStartedAt: number }>();

	function assertLoginAllowed(clientKey: string): void {
		const maxFailures = runtime.config.maxLoginFailures;
		if (maxFailures === 0) return;
		const entry = loginFailures.get(clientKey);
		if (!entry) return;
		if (runtime.clock() - entry.windowStartedAt >= LOGIN_FAILURE_WINDOW_MS) {
			loginFailures.delete(clientKey);
			return;
		}
		if (entry.count >= maxFailures) {
			throw tooManyRequests("AUTH_RATE_LIMITED", "Too many failed login attempts; try again later");
		}
	}

	function recordLoginFailure(clientKey: string): void {
		if (runtime.config.maxLoginFailures === 0) return;
		const entry = loginFailures.get(clientKey);
		if (!entry || runtime.clock() - entry.windowStartedAt >= LOGIN_FAILURE_WINDOW_MS) {
			loginFailures.set(clientKey, { count: 1, windowStartedAt: runtime.clock() });
			return;
		}
		entry.count += 1;
	}

	class AuthController {
		async register(body: unknown): Promise<AuthSessionResponse> {
			if (!runtime.config.allowRegistration) {
				throw forbidden("REGISTRATION_DISABLED", "Account registration is disabled on this marketplace");
			}
			const record = bodyObject(body);
			const username = bodyString(record, "username", 64, 3);
			if (!USERNAME_PATTERN.test(username)) {
				throw badRequest("BODY_INVALID", "username must be lowercase letters, digits, and ._- separators");
			}
			const password = bodyString(record, "password", 128, 8);
			const passwordHash = await hashPassword(password);
			const user = await mapStoreErrorsAsync(() => runtime.store.createUser(username, passwordHash));
			return issueSession(runtime, user.id, user.username, user.createdAt);
		}

		async login(body: unknown, request: LoginRequestLike): Promise<AuthSessionResponse> {
			const record = bodyObject(body);
			const username = bodyString(record, "username", 64);
			const password = bodyString(record, "password", 128);
			const clientKey = request.ip ?? "unknown";
			assertLoginAllowed(clientKey);
			const user = await runtime.store.getUserByUsername(username);
			// Verify against a dummy hash for unknown usernames so the timing matches known ones.
			const passwordValid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
			if (!user || !passwordValid) {
				recordLoginFailure(clientKey);
				throw unauthorized("AUTH_INVALID", "Invalid username or password");
			}
			loginFailures.delete(clientKey);
			return issueSession(runtime, user.id, user.username, user.createdAt);
		}

		async logout(authorization: string | undefined): Promise<void> {
			if (authorization === undefined) throw unauthorized("AUTH_REQUIRED", "Authorization is required");
			await runtime.store.deleteSession(hashToken(bearerToken(authorization)));
		}

		async me(authorization: string | undefined): Promise<AuthMeResponse> {
			const principal = await requirePrincipal(runtime, authorization);
			if (principal.kind === "admin") return { admin: true, publisherIds: [] };
			const publisherIds = await runtime.store.publisherIdsForUser(principal.userId);
			return {
				admin: false,
				user: { username: principal.username, createdAt: principal.createdAt },
				publisherIds,
			};
		}
	}

	applyController(AuthController, "v1/auth");
	applyRoute(AuthController.prototype, "register", "post", "register");
	applyParameter(AuthController.prototype, "register", 0, Body());
	applyRoute(AuthController.prototype, "login", "post", "login");
	applyHttpCode(AuthController.prototype, "login", 200);
	applyParameter(AuthController.prototype, "login", 0, Body());
	applyParameter(AuthController.prototype, "login", 1, Req());
	applyRoute(AuthController.prototype, "logout", "post", "logout");
	applyHttpCode(AuthController.prototype, "logout", 204);
	applyParameter(AuthController.prototype, "logout", 0, Headers("authorization"));
	applyRoute(AuthController.prototype, "me", "get", "me");
	applyParameter(AuthController.prototype, "me", 0, Headers("authorization"));

	return [AuthController];
}

async function issueSession(
	runtime: MarketplaceHttpRuntime,
	userId: number,
	username: string,
	createdAt: number,
): Promise<AuthSessionResponse> {
	const { token, tokenHash } = generateSessionToken();
	const expiresAt = Math.trunc(runtime.clock()) + SESSION_TTL_MS;
	await runtime.store.createSession(tokenHash, userId, expiresAt);
	return { token, expiresAt, user: { username, createdAt } };
}
