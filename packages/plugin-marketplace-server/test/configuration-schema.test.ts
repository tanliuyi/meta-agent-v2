import { describe, expect, it } from "vitest";
import { parsePluginConfigurationSchema } from "../src/configuration-schema.ts";

describe("plugin configuration schema", () => {
	it("accepts every Desktop-rendered declarative field type", () => {
		expect(
			parsePluginConfigurationSchema({
				version: 1,
				fields: [
					{ key: "query", label: "查询", type: "text", required: true, minLength: 1 },
					{ key: "instructions", label: "说明", type: "textarea", maxLength: 4000 },
					{ key: "limit", label: "数量", type: "number", minimum: 1, maximum: 20, defaultValue: 5 },
					{ key: "enabled", label: "启用", type: "boolean", defaultValue: true },
					{
						key: "mode",
						label: "模式",
						type: "select",
						options: [
							{ value: "fast", label: "快速" },
							{ value: "deep", label: "深入" },
						],
					},
					{ key: "token", label: "令牌", type: "secret", required: true },
					{ key: "workspace", label: "目录", type: "path" },
				],
			}),
		).toMatchObject({ version: 1, fields: expect.arrayContaining([expect.objectContaining({ type: "secret" })]) });
	});

	it("rejects executable or unknown presentation properties", () => {
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "unsafe", label: "不安全", type: "text", component: "<script />" }],
			}),
		).toThrow("unsupported property");
		expect(() =>
			parsePluginConfigurationSchema({
				version: 1,
				fields: [{ key: "token", label: "令牌", type: "secret", defaultValue: "plaintext" }],
			}),
		).toThrow("unsupported property");
	});
});
