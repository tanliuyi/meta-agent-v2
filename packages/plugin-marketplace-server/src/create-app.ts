import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { MarketplaceServerConfig } from "./config.ts";
import { createMarketplaceHttpModule } from "./http-module.ts";
import { MarketplaceSigningService } from "./signing-service.ts";
import { MarketplaceStore } from "./store.ts";

export interface CreateMarketplaceAppOptions {
	config: MarketplaceServerConfig;
	catalogPath?: URL;
	clock?(): number;
	logger?: false | Array<"error" | "warn" | "log" | "debug" | "verbose" | "fatal">;
}

export async function createMarketplaceApp(options: CreateMarketplaceAppOptions): Promise<INestApplication> {
	const clock = options.clock ?? Date.now;
	const signing = new MarketplaceSigningService(options.config.signingPrivateKey);
	const store = await MarketplaceStore.open({
		databaseUrl: options.config.databaseUrl,
		...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
		signing,
		marketplaceId: options.config.marketplaceId,
		clock,
	});
	try {
		const module = createMarketplaceHttpModule({
			config: options.config,
			store,
			signing,
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
