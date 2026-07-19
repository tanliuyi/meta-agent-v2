import { describe, expect, test } from "vitest";
import {
	getModelsConfigMetadata,
	parseModelsConfigSource,
	validateModelsConfigValue,
} from "../src/core/models-config.ts";

describe("models config parser", () => {
	test("parses comments and trailing commas without resolving config values", () => {
		const source = `{
			// provider comment
			"providers": {
				"local": {
					"baseUrl": "http://localhost:11434/v1",
					"api": "openai-completions",
					"apiKey": "!printf should-not-run",
					"headers": { "X-Key": "$MISSING_MODELS_TEST_KEY" },
					"models": [{ "id": "qwen", }],
				},
			},
		}`;

		const result = parseModelsConfigSource(source);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.providers.local?.apiKey).toBe("!printf should-not-run");
		expect(result.value.providers.local?.headers?.["X-Key"]).toBe("$MISSING_MODELS_TEST_KEY");
	});

	test("returns syntax diagnostics with segment paths", () => {
		const result = parseModelsConfigSource('{ "providers": { "a.b/c:d": { "models": [ } } }', "custom.json");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toMatch(/^syntax\./);
		expect(result.diagnostics[0]?.message).toContain("custom.json");
	});

	test("returns schema paths without flattening provider identity", () => {
		const result = validateModelsConfigValue({
			providers: {
				"a.b/c:d": {
					baseUrl: "http://localhost",
					api: "openai-completions",
					models: [{ id: "m", maxTokens: "wrong" }],
				},
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some((diagnostic) => diagnostic.path.includes("a.b/c:d"))).toBe(true);
	});

	test("validates semantic requirements and duplicate model ids", () => {
		const result = validateModelsConfigValue({
			providers: {
				custom: {
					api: "openai-completions",
					models: [
						{ id: "duplicate", contextWindow: 0 },
						{ id: "duplicate", maxTokens: -1 },
					],
				},
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("baseUrl");
		expect(messages).toContain("duplicate model id");
		expect(messages).toContain("greater than zero");
	});

	test("accepts all current compat fields and rejects invalid known values", () => {
		const valid = validateModelsConfigValue({
			providers: {
				anthropic: {
					compat: { allowEmptySignature: true, supportsTemperature: false },
					modelOverrides: {
						claude: { compat: { allowEmptySignature: false } },
					},
				},
				openai: {
					compat: { zaiToolStream: true, chatTemplateKwargs: { enable_thinking: true } },
					modelOverrides: { gpt: {} },
				},
			},
		});
		expect(valid.ok).toBe(true);

		const invalid = validateModelsConfigValue({
			providers: {
				anthropic: {
					compat: { allowEmptySignature: "yes" },
					modelOverrides: { claude: {} },
				},
			},
		});
		expect(invalid.ok).toBe(false);
	});

	test("accepts unknown future fields while validating recognized fields", () => {
		const result = validateModelsConfigValue({
			futureRoot: true,
			providers: {
				anthropic: {
					futureProviderField: { enabled: true },
					compat: { futureCompatField: "value", allowEmptySignature: true },
					modelOverrides: { claude: {} },
				},
			},
		});
		expect(result.ok).toBe(true);
	});

	test("rejects empty provider and override keys and invalid costs", () => {
		const result = validateModelsConfigValue({
			providers: {
				"": { baseUrl: "http://localhost", modelOverrides: { "": { maxTokens: 0 } } },
				custom: {
					baseUrl: "http://localhost",
					api: "openai-completions",
					models: [
						{
							id: "m",
							cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("provider key");
		expect(messages).toContain("model override key");
		expect(messages).toContain("zero or greater");
	});
});

describe("models config metadata", () => {
	test("returns deterministic structured-clone-safe built-in metadata", () => {
		const first = getModelsConfigMetadata();
		const second = getModelsConfigMetadata();
		expect(second).toEqual(first);
		expect(structuredClone(first)).toEqual(first);
		expect(first.knownApis.length).toBeGreaterThan(0);
		expect(first.builtInProviders.length).toBeGreaterThan(0);
		expect(first.builtInProviders[0]).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				displayName: expect.any(String),
				models: expect.any(Array),
			}),
		);
		expect(first.builtInProviders.flatMap((provider) => provider.models)[0]).toEqual(
			expect.objectContaining({ id: expect.any(String), name: expect.any(String), api: expect.any(String) }),
		);
	});
});
