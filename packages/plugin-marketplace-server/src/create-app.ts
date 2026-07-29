import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { MarketplaceServerConfig } from "./config.ts";
import { createMarketplaceHttpModule } from "./http-module.ts";
import { MarketplaceStore } from "./store.ts";

export interface CreateMarketplaceAppOptions {
	config: MarketplaceServerConfig;
	catalogPath?: URL;
	clock?(): number;
	logger?: false | Array<"error" | "warn" | "log" | "debug" | "verbose" | "fatal">;
}

export async function createMarketplaceApp(options: CreateMarketplaceAppOptions): Promise<INestApplication> {
	const clock = options.clock ?? Date.now;
	let databasePath: string | undefined;
	if (options.config.dataDir) {
		mkdirSync(options.config.dataDir, { recursive: true });
		databasePath = join(options.config.dataDir, "marketplace.db");
	}
	const store = await MarketplaceStore.open({
		...(databasePath ? { databasePath } : {}),
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
		store.close();
		throw error;
	}
}
