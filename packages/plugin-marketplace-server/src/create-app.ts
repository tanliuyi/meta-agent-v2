import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MarketplaceArtifactService } from "./artifact-service.ts";
import { CatalogRepository } from "./catalog-repository.ts";
import type { MarketplaceServerConfig } from "./config.ts";
import { createMarketplaceHttpModule } from "./http-module.ts";
import { MarketplaceSigningService } from "./signing-service.ts";

export interface CreateMarketplaceAppOptions {
	config: MarketplaceServerConfig;
	catalogPath?: URL;
	clock?(): number;
	logger?: false | Array<"error" | "warn" | "log" | "debug" | "verbose" | "fatal">;
}

export async function createMarketplaceApp(options: CreateMarketplaceAppOptions): Promise<INestApplication> {
	const repository = await CatalogRepository.load(options.catalogPath);
	const signing = new MarketplaceSigningService(options.config.signingPrivateKey);
	const artifacts = new MarketplaceArtifactService(repository, signing, options.config.marketplaceId);
	const module = createMarketplaceHttpModule({
		config: options.config,
		repository,
		signing,
		artifacts,
		clock: options.clock ?? Date.now,
	});
	const app = await NestFactory.create(module, {
		logger: options.logger ?? ["error", "warn", "log"],
	});
	if (options.config.basePath) app.setGlobalPrefix(options.config.basePath.slice(1));
	app.enableShutdownHooks();
	return app;
}
