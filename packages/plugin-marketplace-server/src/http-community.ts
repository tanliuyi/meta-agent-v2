import { Body, Headers, Param, type Type } from "@nestjs/common";
import type { PluginRatingAggregate, PluginRatingsResponse, PluginStatsResponse } from "./contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import {
	bodyInteger,
	bodyObject,
	bodyOptionalString,
	type MarketplaceHttpRuntime,
	mapStoreErrors,
	notFound,
	requireUser,
} from "./http-util.ts";

const RATINGS_PAGE_SIZE = 50;

export function createCommunityControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	class CommunityController {
		ratings(pluginId: string): PluginRatingsResponse {
			requirePublicPlugin(runtime, pluginId);
			return {
				rating: runtime.store.ratingAggregate(pluginId),
				histogram: runtime.store.ratingHistogram(pluginId),
				ratings: runtime.store.ratingsFor(pluginId, RATINGS_PAGE_SIZE),
			};
		}

		rate(pluginId: string, body: unknown, authorization: string | undefined): { rating: PluginRatingAggregate } {
			const principal = requireUser(runtime, authorization);
			const record = bodyObject(body);
			const stars = bodyInteger(record, "stars", 1, 5);
			const review = bodyOptionalString(record, "review", 2000);
			mapStoreErrors(() => runtime.store.upsertRating(pluginId, principal.userId, stars, review));
			return { rating: runtime.store.ratingAggregate(pluginId) };
		}

		unrate(pluginId: string, authorization: string | undefined): void {
			const principal = requireUser(runtime, authorization);
			mapStoreErrors(() => runtime.store.deleteRating(pluginId, principal.userId));
		}

		stats(pluginId: string): PluginStatsResponse {
			requirePublicPlugin(runtime, pluginId);
			return {
				downloadCount: runtime.store.downloadTotal(pluginId),
				downloadsByVersion: runtime.store.downloadsByVersion(pluginId),
				rating: runtime.store.ratingAggregate(pluginId),
			};
		}
	}

	applyController(CommunityController, "v1/plugins");
	applyRoute(CommunityController.prototype, "ratings", "get", ":pluginId/ratings");
	applyParameter(CommunityController.prototype, "ratings", 0, Param("pluginId"));
	applyRoute(CommunityController.prototype, "rate", "put", ":pluginId/rating");
	applyParameter(CommunityController.prototype, "rate", 0, Param("pluginId"));
	applyParameter(CommunityController.prototype, "rate", 1, Body());
	applyParameter(CommunityController.prototype, "rate", 2, Headers("authorization"));
	applyRoute(CommunityController.prototype, "unrate", "delete", ":pluginId/rating");
	applyHttpCode(CommunityController.prototype, "unrate", 204);
	applyParameter(CommunityController.prototype, "unrate", 0, Param("pluginId"));
	applyParameter(CommunityController.prototype, "unrate", 1, Headers("authorization"));
	applyRoute(CommunityController.prototype, "stats", "get", ":pluginId/stats");
	applyParameter(CommunityController.prototype, "stats", 0, Param("pluginId"));

	return [CommunityController];
}

function requirePublicPlugin(runtime: MarketplaceHttpRuntime, pluginId: string): void {
	if (!runtime.store.hasPublicPlugin(pluginId)) {
		throw notFound("PLUGIN_NOT_FOUND", `Plugin not found: ${pluginId}`);
	}
}
