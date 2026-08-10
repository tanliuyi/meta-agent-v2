import { describe, expect, it } from "vitest";
import { parsePluginConfigurationSchema } from "../src/configuration-schema.ts";

describe("plugin configuration schema", () => {
	it("normalizes group, order, deprecated, pattern, and option description metadata", () => {
		const schema = parsePluginConfigurationSchema({
			version: 1,
			fields: [
				{
					key: "endpoint",
					label: "Endpoint",
					type: "text",
					required: true,
					group: "Connection",
					order: 2,
					defaultValue: "https://example.test",
					pattern: "^https?://",
					patternMessage: "Endpoint must start with http:// or https://",
				},
				{
					key: "legacy",
					label: "Legacy",
					type: "select",
					group: "Connection",
					order: 1,
					deprecated: true,
					deprecatedMessage: "Use endpoint instead",
					options: [
						{ value: "a", label: "A", description: "Option A" },
						{ value: "b", label: "B" },
					],
					defaultValue: "a",
				},
			],
		});

		expect(schema).toEqual({
			version: 1,
			fields: [
				{
					key: "endpoint",
					label: "Endpoint",
					required: true,
					group: "Connection",
					order: 2,
					type: "text",
					defaultValue: "https://example.test",
					pattern: "^https?://",
					patternMessage: "Endpoint must start with http:// or https://",
				},
				{
					key: "legacy",
					label: "Legacy",
					group: "Connection",
					order: 1,
					deprecated: true,
					deprecatedMessage: "Use endpoint instead",
					type: "select",
					options: [
						{ value: "a", label: "A", description: "Option A" },
						{ value: "b", label: "B" },
					],
					defaultValue: "a",
				},
			],
		});
	});

	it("rejects unsafe patterns and defaults that do not match their pattern", () => {
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "name", label: "Name", type: "text", pattern: "^(a+)+$" }],
			}),
		).toThrow("pattern is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [
					{
						key: "endpoint",
						label: "Endpoint",
						type: "text",
						defaultValue: "ftp://example.test",
						pattern: "^https?://",
					},
				],
			}),
		).toThrow("default does not match its pattern");
	});
	it("rejects invalid pattern, ordering, and metadata bounds", () => {
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", pattern: "[" }],
			}),
		).toThrow("pattern is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", order: -1 }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", order: 1.5 }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", group: "x".repeat(65) }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", deprecatedMessage: "x".repeat(241) }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", patternMessage: "x".repeat(241) }],
			}),
		).toThrow("text is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [
					{
						key: "mode",
						label: "Mode",
						type: "select",
						options: [{ value: "a", label: "A", description: "x".repeat(241) }],
					},
				],
			}),
		).toThrow("option is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", component: "script" }],
			}),
		).toThrow("unsupported property");
	});

	it("keeps accepting legacy schemas without the new metadata", () => {
		expect(
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "endpoint", label: "Endpoint", type: "text", required: true }],
			}),
		).toEqual({
			version: 1,
			fields: [{ key: "endpoint", label: "Endpoint", required: true, type: "text" }],
		});
	});

	it("accepts model-selector widget and modelFormat metadata", () => {
		const schema = parsePluginConfigurationSchema({
			version: 1,
			fields: [
				{
					key: "searchModel",
					label: "Search model",
					type: "text",
					widget: "model-selector",
					modelFormat: "model-id",
				},
				{
					key: "summaryModel",
					label: "Summary model",
					type: "text",
					widget: "model-selector",
					modelFormat: "provider-model",
				},
			],
		});

		expect(schema).toEqual({
			version: 1,
			fields: [
				{
					key: "searchModel",
					label: "Search model",
					type: "text",
					widget: "model-selector",
					modelFormat: "model-id",
				},
				{
					key: "summaryModel",
					label: "Summary model",
					type: "text",
					widget: "model-selector",
					modelFormat: "provider-model",
				},
			],
		});
	});

	it("rejects invalid widget and modelFormat values", () => {
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "m", label: "M", type: "text", widget: "input" }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "m", label: "M", type: "text", widget: "model-selector", modelFormat: "full-id" }],
			}),
		).toThrow("metadata is invalid");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "m", label: "M", type: "text", modelFormat: "model-id" }],
			}),
		).toThrow("metadata is invalid");
	});
});
