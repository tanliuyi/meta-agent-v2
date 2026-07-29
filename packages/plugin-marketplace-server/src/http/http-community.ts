import { Body, Headers, Param, type Type } from "@nestjs/common";
import type { PluginRatingAggregate, PluginRatingsResponse, PluginStatsResponse } from "../contracts.ts";
import { applyController, applyHttpCode, applyParameter, applyRoute } from "./http-decorators.ts";
import {
	bodyInteger,
	bodyObject,
	bodyOptionalString,
	type MarketplaceHttpRuntime,
	mapStoreErrorsAsync,
	notFound,
	requireUser,
} from "./http-util.ts";

const RATINGS_PAGE_SIZE = 50;

export function createCommunityControllers(runtime: MarketplaceHttpRuntime): Type<unknown>[] {
	class CommunityController {
		async ratings(pluginId: string): Promise<PluginRatingsResponse> {
			await requirePublicPlugin(runtime, pluginId);
			const [rating, histogram, ratings] = await Promise.all([
				runtime.store.ratingAggregate(pluginId),
				runtime.store.ratingHistogram(pluginId),
				runtime.store.ratingsFor(pluginId, RATINGS_PAGE_SIZE),
			]);
			return { rating, histogram, ratings };
		}

		async rate(
			pluginId: string,
			body: unknown,
			authorization: string | undefined,
		): Promise<{ rating: PluginRatingAggregate }> {
			const principal = await requireUser(runtime, authorization);
			const record = bodyObject(body);
			const stars = bodyInteger(record, "stars", 1, 5);
			const review = bodyOptionalString(record, "review", 2000);
			await mapStoreErrorsAsync(() => runtime.store.upsertRating(pluginId, principal.userId, stars, review));
			const rating = await runtime.store.ratingAggregate(pluginId);
			return { rating };
		}

		async unrate(pluginId: string, authorization: string | undefined): Promise<void> {
			const principal = await requireUser(runtime, authorization);
			await mapStoreErrorsAsync(() => runtime.store.deleteRating(pluginId, principal.userId));
		}

		async stats(pluginId: string): Promise<PluginStatsResponse> {
			await requirePublicPlugin(runtime, pluginId);
			const [downloadCount, downloadsByVersion, rating] = await Promise.all([
				runtime.store.downloadTotal(pluginId),
				runtime.store.downloadsByVersion(pluginId),
				runtime.store.ratingAggregate(pluginId),
			]);
			return { downloadCount, downloadsByVersion, rating };
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

async function requirePublicPlugin(runtime: MarketplaceHttpRuntime, pluginId: string): Promise<void> {
	const exists = await runtime.store.hasPublicPlugin(pluginId);
	if (!exists) {
		throw notFound("PLUGIN_NOT_FOUND", `Plugin not found: ${pluginId}`);
	}
}
