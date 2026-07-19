/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	type AnthropicMessagesCompat,
	type Api,
	type AssistantMessageEventStream,
	type BuiltinProvider,
	type Context,
	getModels,
	getProviders,
	type Model,
	type OAuthProviderInterface,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import {
	formatModelsConfigDiagnostics,
	type ModelsModelOverride as ModelOverride,
	type ModelsConfig,
	parseModelsConfigSource,
} from "./models-config.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { registerCustomRadiusOAuthProvider } from "./radius.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

/** Provider override config (baseUrl, compat) without request auth/headers */
interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	/** Providers with baseUrl/headers/apiKey overrides for built-in models */
	overrides: Map<string, ProviderOverride>;
	/** Per-model overrides: provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	if (baseCompletions?.chatTemplateKwargs || overrideCompletions.chatTemplateKwargs) {
		mergedCompletions.chatTemplateKwargs = {
			...baseCompletions?.chatTemplateKwargs,
			...overrideCompletions.chatTemplateKwargs,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// Merge cost (partial override)
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
			tiers: override.cost.tiers ?? model.cost.tiers,
		};
	}

	// Deep merge compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private configModelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private loadError: string | undefined = undefined;
	readonly authStorage: AuthStorage;
	private modelsJsonPath: string | undefined;

	private constructor(authStorage: AuthStorage, modelsJsonPath: string | undefined) {
		this.authStorage = authStorage;
		this.modelsJsonPath = modelsJsonPath ? normalizePath(modelsJsonPath) : undefined;
		this.loadModels();
	}

	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		return new ModelRegistry(authStorage, modelsJsonPath);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, undefined);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.loadError = undefined;

		// Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
		resetApiProviders();
		resetOAuthProviders();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		// Load custom models and overrides from models.json
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();
		this.configModelOverrides = modelOverrides;

		if (error) {
			this.loadError = error;
			// Keep built-in models even if custom models failed to load
		}

		const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
		let combined = this.mergeCustomModels(builtInModels, customModels);

		// Let OAuth providers modify their models (e.g., update baseUrl)
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			const cred = this.authStorage.get(oauthProvider.id);
			if (cred?.type === "oauth" && oauthProvider.modifyModels) {
				combined = oauthProvider.modifyModels(combined, cred);
			}
		}

		this.models = combined;
	}

	/** Load built-in models and apply provider/model overrides */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as BuiltinProvider) as Model<Api>[];
			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// Apply provider-level baseUrl/headers/compat override
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model override
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	private getConfiguredModelOverride(providerName: string, modelId: string): ModelOverride | undefined {
		return this.configModelOverrides.get(providerName)?.get(modelId);
	}

	private applyConfiguredModelOverride(providerName: string, model: Model<Api>): Model<Api> {
		const modelOverride = this.getConfiguredModelOverride(providerName, model.id);
		return modelOverride ? applyModelOverride(model, modelOverride) : model;
	}

	/** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const parsed = parseModelsConfigSource(content, modelsJsonPath);
			if (!parsed.ok) {
				const errors = formatModelsConfigDiagnostics(parsed.diagnostics) || "Unknown models.json error";
				return emptyCustomModelsResult(`Invalid models.json:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}
			const config = parsed.value;
			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				if (providerConfig.baseUrl || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						compat: providerConfig.compat,
					});
				}

				if (providerConfig.oauth === "radius") {
					// Must run before the modifyModels loop in loadModels() so the
					// credential-cached catalog is injected on this load.
					registerCustomRadiusOAuthProvider(providerName, providerConfig.name, providerConfig.baseUrl!);
				}

				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
					}
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getProviders());

		// Cache built-in defaults (api, baseUrl) per provider, extracted from first model.
		const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
		const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
			const builtIn = getModels(providerName as BuiltinProvider) as Model<Api>[];
			if (builtIn.length === 0) return undefined;
			const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				const compat = mergeCompat(providerConfig.compat, modelDef.compat);
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: undefined,
					compat,
				} as Model<Api>);
			}
		}

		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((m) => this.hasConfiguredAuth(m));
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		return (
			this.authStorage.hasAuth(model.provider) ||
			(providerApiKey !== undefined && isConfigValueConfigured(providerApiKey))
		);
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * Get API key and request headers for a model.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const providerEnv = this.authStorage.getProviderEnv(model.provider);
			const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
			const apiKey =
				apiKeyFromAuthStorage ??
				(providerConfig?.apiKey
					? resolveConfigValueOrThrow(
							providerConfig.apiKey,
							`API key for provider "${model.provider}"`,
							providerEnv,
						)
					: undefined);

			const providerHeaders = resolveHeadersOrThrow(
				providerConfig?.headers,
				`provider "${model.provider}"`,
				providerEnv,
			);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
				providerEnv,
			);

			let headers =
				model.headers || providerHeaders || modelHeaders
					? { ...model.headers, ...providerHeaders, ...modelHeaders }
					: undefined;

			if (providerConfig?.authHeader) {
				if (!apiKey) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
				env: providerEnv && Object.keys(providerEnv).length > 0 ? providerEnv : undefined,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Return auth status for a provider, including request auth configured in models.json.
	 * This intentionally does not execute command-backed config values.
	 */
	getProviderAuthStatus(provider: string): AuthStatus {
		const authStatus = this.authStorage.getAuthStatus(provider);
		if (authStatus.source) {
			return authStatus;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			return authStatus;
		}

		if (isCommandConfigValue(providerApiKey)) {
			return { configured: true, source: "models_json_command" };
		}

		const envVarNames = getConfigValueEnvVarNames(providerApiKey);
		if (envVarNames.length > 0) {
			return isConfigValueConfigured(providerApiKey)
				? { configured: true, source: "environment", label: envVarNames.join(", ") }
				: { configured: false };
		}

		return { configured: true, source: "models_json_key" };
	}

	/**
	 * Get display name for a provider.
	 */
	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);
		const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

		return (
			registeredProvider?.name ??
			registeredProvider?.oauth?.name ??
			oauthProvider?.name ??
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			provider
		);
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const apiKey = await this.authStorage.getApiKey(provider);
		if (apiKey !== undefined) {
			return apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey
			? resolveConfigValueUncached(providerApiKey, this.authStorage.getProviderEnv(provider))
			: undefined;
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.upsertRegisteredProvider(providerName, config);
	}

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes the provider from the registry and reloads models from disk so that
	 * built-in models overridden by this provider are restored to their original state.
	 * Also resets dynamic OAuth and API stream registrations before reapplying
	 * remaining dynamic providers.
	 * Has no effect if the provider was never registered.
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	/**
	 * Upsert a provider config into registeredProviders.
	 * If the provider is already registered, defined values in the incoming config
	 * override existing ones; undefined values are preserved from the stored config.
	 * If the provider is not registered, the incoming config is stored as-is.
	 */
	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, config);
			return;
		}
		for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[k] !== undefined) {
				(existing as Record<string, unknown>)[k] = config[k];
			}
		}
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		// Register OAuth provider if provided
		if (config.oauth) {
			// Ensure the OAuth provider ID matches the provider name
			const oauthProvider: OAuthProviderInterface = {
				...config.oauth,
				id: providerName,
			};
			registerOAuthProvider(oauthProvider);
		}

		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}

		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			// Full replacement: remove existing models for this provider
			this.models = this.models.filter((m) => m.provider !== providerName);

			// Parse and add new models
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;
				const modelOverride = this.getConfiguredModelOverride(providerName, modelDef.id);
				const headers =
					modelDef.headers || modelOverride?.headers
						? { ...modelDef.headers, ...modelOverride?.headers }
						: undefined;
				this.storeModelHeaders(providerName, modelDef.id, headers);

				const model = this.applyConfiguredModelOverride(providerName, {
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? config.baseUrl!,
					reasoning: modelDef.reasoning,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>);
				this.models.push(model);
			}

			// Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
			if (config.oauth?.modifyModels) {
				const cred = this.authStorage.get(providerName);
				if (cred?.type === "oauth") {
					this.models = config.oauth.modifyModels(this.models, cred);
				}
			}
		} else if (config.baseUrl || config.headers) {
			// Override-only: update baseUrl for existing models. Request headers are resolved per request.
			this.models = this.models.map((m) => {
				if (m.provider !== providerName) return m;
				return {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
				};
			});
		}
	}
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	/** OAuth provider for /login support */
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: Model<Api>["cost"];
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
