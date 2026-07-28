import { Body, Headers, Param, type Type } from "@nestjs/common";
import { valid as validSemver } from "semver";
import { PLUGIN_ID } from "./catalog-validation.ts";
import type { AdminUserView, CatalogRevocation, PublisherAdminView, UserRole } from "./contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import {
	badRequest,
	bodyBoolean,
	bodyObject,
	bodyOptionalString,
	bodyString,
	bodyStringArray,
	type MarketplaceHttpRuntime,
	mapStoreErrors,
	PUBLISHER_ID_PATTERN,
	requireAdmin,
	requireSuperAdmin,
	USERNAME_PATTERN,
} from "./http-util.ts";

export function createAdminControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	class AdminController {
		async users(authorization: string | undefined): Promise<{ users: AdminUserView[] }> {
			await requireSuperAdmin(runtime, authorization);
			return { users: await runtime.store.listUsers() };
		}

		async updateUserRole(
			username: string,
			body: unknown,
			authorization: string | undefined,
		): Promise<{ user: AdminUserView }> {
			await requireSuperAdmin(runtime, authorization);
			if (!USERNAME_PATTERN.test(username)) {
				throw badRequest("USERNAME_INVALID", "Username must be a lowercase identifier");
			}
			const role = bodyString(bodyObject(body), "role", 32) as UserRole;
			if (role !== "user" && role !== "admin" && role !== "super_admin") {
				throw badRequest("BODY_INVALID", "role must be user, admin, or super_admin");
			}
			return { user: await mapStoreErrors(() => runtime.store.updateUserRole(username, role)) };
		}

		async publishers(authorization: string | undefined): Promise<{ publishers: PublisherAdminView[] }> {
			await requireAdmin(runtime, authorization);
			return { publishers: await runtime.store.listPublishers() };
		}

		async upsertPublisher(
			publisherId: string,
			body: unknown,
			authorization: string | undefined,
		): Promise<{ publisher: PublisherAdminView }> {
			await requireAdmin(runtime, authorization);
			if (!PUBLISHER_ID_PATTERN.test(publisherId)) {
				throw badRequest("PUBLISHER_ID_INVALID", "Publisher ID must be a lowercase identifier");
			}
			const record = bodyObject(body);
			const displayName = bodyString(record, "displayName", 120);
			const verified = bodyBoolean(record, "verified");
			return { publisher: await runtime.store.upsertPublisher(publisherId, displayName, verified) };
		}

		async addMember(publisherId: string, username: string, authorization: string | undefined): Promise<void> {
			await requireAdmin(runtime, authorization);
			validateMemberPath(publisherId, username);
			await mapStoreErrors(() => runtime.store.addPublisherMember(publisherId, username));
		}

		async removeMember(publisherId: string, username: string, authorization: string | undefined): Promise<void> {
			await requireAdmin(runtime, authorization);
			validateMemberPath(publisherId, username);
			await mapStoreErrors(() => runtime.store.removePublisherMember(publisherId, username));
		}

		async revoke(body: unknown, authorization: string | undefined): Promise<{ revocation: CatalogRevocation }> {
			await requireAdmin(runtime, authorization);
			const record = bodyObject(body);
			const pluginId = bodyString(record, "pluginId", 200);
			if (!PLUGIN_ID.test(pluginId)) throw badRequest("BODY_INVALID", "pluginId is not a valid plugin identifier");
			const version = bodyString(record, "version", 64);
			if (!validSemver(version)) throw badRequest("BODY_INVALID", "version must be semver");
			const status = bodyString(record, "status", 16);
			if (status !== "withdrawn" && status !== "blocked") {
				throw badRequest("BODY_INVALID", "status must be withdrawn or blocked");
			}
			const replacementVersion = bodyOptionalString(record, "replacementVersion", 64);
			if (replacementVersion !== undefined && !validSemver(replacementVersion)) {
				throw badRequest("BODY_INVALID", "replacementVersion must be semver");
			}
			const revocation: CatalogRevocation = {
				pluginId,
				version,
				...(record.artifactIds === undefined
					? {}
					: { artifactIds: bodyStringArray(record, "artifactIds", 16, 128) }),
				status,
				reasonCode: bodyString(record, "reasonCode", 64),
				message: bodyString(record, "message", 500),
				...(replacementVersion === undefined ? {} : { replacementVersion }),
			};
			await mapStoreErrors(() => runtime.store.applyRevocation(revocation));
			return { revocation };
		}
	}

	applyController(AdminController, "v1/admin");
	applyRoute(AdminController.prototype, "users", "get", "users");
	applyParameter(AdminController.prototype, "users", 0, Headers("authorization"));
	applyRoute(AdminController.prototype, "updateUserRole", "put", "users/:username/role");
	applyParameter(AdminController.prototype, "updateUserRole", 0, Param("username"));
	applyParameter(AdminController.prototype, "updateUserRole", 1, Body());
	applyParameter(AdminController.prototype, "updateUserRole", 2, Headers("authorization"));
	applyRoute(AdminController.prototype, "publishers", "get", "publishers");
	applyParameter(AdminController.prototype, "publishers", 0, Headers("authorization"));
	applyRoute(AdminController.prototype, "upsertPublisher", "put", "publishers/:publisherId");
	applyParameter(AdminController.prototype, "upsertPublisher", 0, Param("publisherId"));
	applyParameter(AdminController.prototype, "upsertPublisher", 1, Body());
	applyParameter(AdminController.prototype, "upsertPublisher", 2, Headers("authorization"));
	applyRoute(AdminController.prototype, "addMember", "put", "publishers/:publisherId/members/:username");
	applyHttpCode(AdminController.prototype, "addMember", 204);
	applyParameter(AdminController.prototype, "addMember", 0, Param("publisherId"));
	applyParameter(AdminController.prototype, "addMember", 1, Param("username"));
	applyParameter(AdminController.prototype, "addMember", 2, Headers("authorization"));
	applyRoute(AdminController.prototype, "removeMember", "delete", "publishers/:publisherId/members/:username");
	applyHttpCode(AdminController.prototype, "removeMember", 204);
	applyParameter(AdminController.prototype, "removeMember", 0, Param("publisherId"));
	applyParameter(AdminController.prototype, "removeMember", 1, Param("username"));
	applyParameter(AdminController.prototype, "removeMember", 2, Headers("authorization"));
	applyRoute(AdminController.prototype, "revoke", "post", "revocations");
	applyParameter(AdminController.prototype, "revoke", 0, Body());
	applyParameter(AdminController.prototype, "revoke", 1, Headers("authorization"));

	return [AdminController];
}

function validateMemberPath(publisherId: string, username: string): void {
	if (!PUBLISHER_ID_PATTERN.test(publisherId)) {
		throw badRequest("PUBLISHER_ID_INVALID", "Publisher ID must be a lowercase identifier");
	}
	if (!USERNAME_PATTERN.test(username)) {
		throw badRequest("USERNAME_INVALID", "Username must be a lowercase identifier");
	}
}
