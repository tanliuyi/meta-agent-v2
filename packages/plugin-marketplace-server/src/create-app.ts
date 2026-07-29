import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import type { MarketplaceServerConfig } from "./config.ts";
import { MarketplaceStore } from "./database/store.ts";
import { createMarketplaceHttpModule } from "./http/http-module.ts";

export interface CreateMarketplaceAppOptions {
	config: MarketplaceServerConfig;
	pool?: Pool;
	catalogPath?: URL;
	clock?(): number;
	logger?: false | Array<"error" | "warn" | "log" | "debug" | "verbose" | "fatal">;
}

export async function createMarketplaceApp(options: CreateMarketplaceAppOptions): Promise<INestApplication> {
	const clock = options.clock ?? Date.now;
	const store = await MarketplaceStore.open({
		pool: options.pool,
		databaseUrl: options.config.databaseUrl,
		artifactDirectory: options.config.dataDir,
		...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
		marketplaceId: options.config.marketplaceId,
		clock,
	});
	try {
		const module = createMarketplaceHttpModule({
			config: options.config,
			store,
			clock,
		});
		const app = await NestFactory.create(module, {
			logger: options.logger ?? ["error", "warn", "log"],
		});
		if (options.config.basePath) app.setGlobalPrefix(options.config.basePath.slice(1));
		app.enableShutdownHooks();
		return app;
	} catch (error) {
		await store.close();
		throw error;
	}
}
