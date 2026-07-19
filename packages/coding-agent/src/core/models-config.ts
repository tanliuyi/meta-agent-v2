import { type Api, type BuiltinProvider, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { getLocation, type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
	max: Type.Optional(ThinkingLevelMapValueSchema),
});

const ChatTemplateKwargScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const ChatTemplateKwargVariableSchema = Type.Object({
	$var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
	omitWhenOff: Type.Optional(Type.Boolean()),
});
const ChatTemplateKwargSchema = Type.Union([ChatTemplateKwargScalarSchema, ChatTemplateKwargVariableSchema]);

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("chat-template"),
			Type.Literal("qwen-chat-template"),
			Type.Literal("string-thinking"),
			Type.Literal("ant-ling"),
		]),
	),
	chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	zaiToolStream: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	supportsToolSearch: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	allowEmptySignature: Type.Optional(Type.Boolean()),
	supportsToolReferences: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Intersect([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

const ModelCostRatesSchema = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};
const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	...ModelCostRatesSchema,
});
const ModelCostSchema = Type.Object({
	...ModelCostRatesSchema,
	tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(ModelCostSchema),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
			tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	oauth: Type.Optional(Type.Literal("radius")),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

const compiledModelsConfig = Compile(ModelsConfigSchema);

export type ModelsChatTemplateKwarg = Static<typeof ChatTemplateKwargSchema>;
export type ModelsOpenAICompletionsCompat = Static<typeof OpenAICompletionsCompatSchema>;
export type ModelsOpenAIResponsesCompat = Static<typeof OpenAIResponsesCompatSchema>;
export type ModelsAnthropicMessagesCompat = Static<typeof AnthropicMessagesCompatSchema>;
export type ModelsCompat = Static<typeof ProviderCompatSchema>;
export type ModelsCompatWithoutFreeMaps = Omit<ModelsCompat, "chatTemplateKwargs">;
export type ModelsModelDefinition = Static<typeof ModelDefinitionSchema>;
export type ModelsModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelsConfig = Static<typeof ModelsConfigSchema>;

export interface ModelsConfigDiagnostic {
	severity: "error" | "warning";
	code: string;
	path: readonly (string | number)[];
	message: string;
}

export type ModelsConfigValidationResult =
	| { ok: true; value: ModelsConfig; diagnostics: ModelsConfigDiagnostic[] }
	| { ok: false; diagnostics: ModelsConfigDiagnostic[] };

export type ModelsConfigParseResult = ModelsConfigValidationResult;

export interface ModelsConfigMetadata {
	knownApis: string[];
	builtInProviders: Array<{
		id: string;
		displayName: string;
		models: Array<{ id: string; name: string; api: string }>;
	}>;
}

export function parseModelsConfigSource(source: string, path = "models.json"): ModelsConfigParseResult {
	const errors: ParseError[] = [];
	const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
	if (errors.length > 0) {
		return {
			ok: false,
			diagnostics: errors.map((error) => ({
				severity: "error",
				code: `syntax.${printParseErrorCode(error.error)}`,
				path: getLocation(source, error.offset).path,
				message: `${printParseErrorCode(error.error)} at offset ${error.offset} in ${path}`,
			})),
		};
	}
	return validateModelsConfigValue(value, path);
}

export function validateModelsConfigValue(value: unknown, path = "models.json"): ModelsConfigValidationResult {
	if (!compiledModelsConfig.Check(value)) {
		return {
			ok: false,
			diagnostics: [...compiledModelsConfig.Errors(value)].map((error) => ({
				severity: "error",
				code: `schema.${error.keyword}`,
				path: validationErrorPath(error, value),
				message: `${error.message} in ${path}`,
			})),
		};
	}

	const config = value as ModelsConfig;
	const diagnostics = validateModelsConfigSemantics(config);
	return diagnostics.some((diagnostic) => diagnostic.severity === "error")
		? { ok: false, diagnostics }
		: { ok: true, value: config, diagnostics };
}

export function getModelsConfigMetadata(): ModelsConfigMetadata {
	const builtInProviders = getProviders().map((provider) => ({
		id: provider,
		displayName: BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider,
		models: (getModels(provider as BuiltinProvider) as Array<{ id: string; name: string; api: Api }>).map(
			(model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
			}),
		),
	}));
	const knownApis = [
		...new Set(builtInProviders.flatMap((provider) => provider.models.map((model) => model.api))),
	].sort();
	return { knownApis, builtInProviders };
}

export function formatModelsConfigDiagnostics(diagnostics: readonly ModelsConfigDiagnostic[]): string {
	return diagnostics
		.map((diagnostic) => `  - ${formatDiagnosticPath(diagnostic.path)}: ${diagnostic.message}`)
		.join("\n");
}

function validateModelsConfigSemantics(config: ModelsConfig): ModelsConfigDiagnostic[] {
	const diagnostics: ModelsConfigDiagnostic[] = [];
	const builtInProviders = new Set<string>(getProviders());

	for (const [providerName, providerConfig] of Object.entries(config.providers)) {
		const providerPath = ["providers", providerName] as const;
		const isBuiltIn = builtInProviders.has(providerName);
		if (providerName.length === 0) {
			diagnostics.push(semanticDiagnostic(providerPath, "provider key must not be empty."));
		}
		const models = providerConfig.models ?? [];
		const hasModelOverrides = Boolean(
			providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0,
		);

		if (providerConfig.oauth && !providerConfig.baseUrl) {
			diagnostics.push(
				semanticDiagnostic([...providerPath, "baseUrl"], '"baseUrl" is required when "oauth" is set.'),
			);
		}

		if (models.length === 0 && !providerConfig.oauth) {
			if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
				diagnostics.push(
					semanticDiagnostic(
						providerPath,
						'must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".',
					),
				);
			}
		} else if (!isBuiltIn && !providerConfig.baseUrl) {
			diagnostics.push(
				semanticDiagnostic([...providerPath, "baseUrl"], '"baseUrl" is required when defining custom models.'),
			);
		}

		for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides ?? {})) {
			const overridePath = [...providerPath, "modelOverrides", modelId] as const;
			if (modelId.length === 0) {
				diagnostics.push(semanticDiagnostic(overridePath, "model override key must not be empty."));
			}
			validatePositiveTokenFields(modelOverride, overridePath, diagnostics);
			validateCost(modelOverride.cost, [...overridePath, "cost"], diagnostics);
		}

		const seenModelIds = new Set<string>();
		for (let index = 0; index < models.length; index += 1) {
			const model = models[index];
			const modelPath = [...providerPath, "models", index] as const;
			if (seenModelIds.has(model.id)) {
				diagnostics.push(semanticDiagnostic([...modelPath, "id"], `duplicate model id "${model.id}".`));
			}
			seenModelIds.add(model.id);
			if (!providerConfig.api && !model.api && !isBuiltIn) {
				diagnostics.push(
					semanticDiagnostic([...modelPath, "api"], 'no "api" specified. Set it at provider or model level.'),
				);
			}
			validatePositiveTokenFields(model, modelPath, diagnostics);
			validateCost(model.cost, [...modelPath, "cost"], diagnostics);
		}
	}

	return diagnostics;
}

function validatePositiveTokenFields(
	value: { contextWindow?: number; maxTokens?: number },
	path: readonly (string | number)[],
	diagnostics: ModelsConfigDiagnostic[],
): void {
	if (value.contextWindow !== undefined && value.contextWindow <= 0) {
		diagnostics.push(semanticDiagnostic([...path, "contextWindow"], "must be greater than zero."));
	}
	if (value.maxTokens !== undefined && value.maxTokens <= 0) {
		diagnostics.push(semanticDiagnostic([...path, "maxTokens"], "must be greater than zero."));
	}
}

function validateCost(
	cost: ModelsModelDefinition["cost"] | ModelsModelOverride["cost"],
	path: readonly (string | number)[],
	diagnostics: ModelsConfigDiagnostic[],
): void {
	if (!cost) return;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const rate = cost[field];
		if (rate !== undefined && rate < 0) {
			diagnostics.push(semanticDiagnostic([...path, field], "must be zero or greater."));
		}
	}
	const seenThresholds = new Set<number>();
	for (let index = 0; index < (cost.tiers?.length ?? 0); index += 1) {
		const tier = cost.tiers![index];
		if (tier.inputTokensAbove < 0) {
			diagnostics.push(
				semanticDiagnostic([...path, "tiers", index, "inputTokensAbove"], "must be zero or greater."),
			);
		}
		if (seenThresholds.has(tier.inputTokensAbove)) {
			diagnostics.push(
				semanticDiagnostic([...path, "tiers", index, "inputTokensAbove"], "duplicate tier threshold."),
			);
		}
		seenThresholds.add(tier.inputTokensAbove);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (tier[field] < 0) {
				diagnostics.push(semanticDiagnostic([...path, "tiers", index, field], "must be zero or greater."));
			}
		}
	}
}

function semanticDiagnostic(path: readonly (string | number)[], message: string): ModelsConfigDiagnostic {
	return { severity: "error", code: "semantic.invalid", path, message };
}

function validationErrorPath(error: TLocalizedValidationError, value: unknown): readonly (string | number)[] {
	const rawSegments = error.instancePath
		.split("/")
		.slice(1)
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	const segments: Array<string | number> = [];
	let current = value;
	for (let index = 0; index < rawSegments.length; index += 1) {
		if (Array.isArray(current)) {
			const arrayIndex = Number(rawSegments[index]);
			segments.push(arrayIndex);
			current = current[arrayIndex];
			continue;
		}
		if (!current || typeof current !== "object") {
			segments.push(rawSegments[index]);
			continue;
		}
		const record = current as Record<string, unknown>;
		let key = rawSegments[index];
		let consumed = 1;
		for (let end = rawSegments.length; end > index + 1; end -= 1) {
			const candidate = rawSegments.slice(index, end).join("/");
			if (Object.hasOwn(record, candidate)) {
				key = candidate;
				consumed = end - index;
				break;
			}
		}
		segments.push(key);
		current = record[key];
		index += consumed - 1;
	}
	if (error.keyword === "required") {
		const required = (error.params as { requiredProperties?: string[] }).requiredProperties?.[0];
		if (required) segments.push(required);
	}
	return segments;
}

function formatDiagnosticPath(path: readonly (string | number)[]): string {
	return path.length === 0 ? "root" : path.map(String).join(".");
}
