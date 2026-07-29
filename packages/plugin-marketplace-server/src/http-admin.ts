import { Body, Headers, Param, type Type } from "@nestjs/common";
import type { PublisherAdminView } from "./contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import {
	badRequest,
	bodyBoolean,
	bodyObject,
	bodyString,
	type MarketplaceHttpRuntime,
	mapStoreErrors,
	PUBLISHER_ID_PATTERN,
	requireAdmin,
	USERNAME_PATTERN,
} from "./http-util.ts";

export function createAdminControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	class AdminController {
		publishers(authorization: string | undefined): { publishers: PublisherAdminView[] } {
			requireAdmin(runtime, authorization);
			return { publishers: runtime.store.listPublishers() };
		}

		upsertPublisher(
			publisherId: string,
			body: unknown,
			authorization: string | undefined,
		): { publisher: PublisherAdminView } {
			requireAdmin(runtime, authorization);
			if (!PUBLISHER_ID_PATTERN.test(publisherId)) {
				throw badRequest("PUBLISHER_ID_INVALID", "Publisher ID must be a lowercase identifier");
			}
			const record = bodyObject(body);
			const displayName = bodyString(record, "displayName", 120);
			const verified = bodyBoolean(record, "verified");
			return { publisher: runtime.store.upsertPublisher(publisherId, displayName, verified) };
		}

		addMember(publisherId: string, username: string, authorization: string | undefined): void {
			requireAdmin(runtime, authorization);
			validateMemberPath(publisherId, username);
			mapStoreErrors(() => runtime.store.addPublisherMember(publisherId, username));
		}

		removeMember(publisherId: string, username: string, authorization: string | undefined): void {
			requireAdmin(runtime, authorization);
			validateMemberPath(publisherId, username);
			mapStoreErrors(() => runtime.store.removePublisherMember(publisherId, username));
		}
	}

	applyController(AdminController, "v1/admin");
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
