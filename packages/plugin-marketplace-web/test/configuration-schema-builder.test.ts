import { describe, expect, it } from "vitest";
import {
  buildConfigurationSchema,
  type ConfigurationFieldDraft,
  createConfigurationFieldDraft,
} from "../src/features/plugins/configuration-schema-builder.tsx";

function field(id: number, patch: Partial<ConfigurationFieldDraft>): ConfigurationFieldDraft {
  return { ...createConfigurationFieldDraft(id), key: `field${id}`, label: `字段 ${id}`, ...patch };
}

describe("configuration schema builder", () => {
  it("builds typed declarative fields without renderer code", () => {
    expect(
      buildConfigurationSchema([
        field(1, { type: "text", defaultValue: "hello", minLength: "1" }),
        field(2, { type: "textarea", maxLength: "4000" }),
        field(3, { type: "number", minimum: "1", maximum: "10", defaultValue: "3" }),
        field(4, { type: "boolean", defaultValue: "true" }),
        field(5, { type: "select", options: "fast=快速\ndeep=深入", defaultValue: "deep" }),
        field(6, { type: "secret", required: true }),
        field(7, { type: "path", placeholder: "/workspace" }),
      ]),
    ).toEqual(
      expect.objectContaining({
        version: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({
            type: "select",
            options: [
              { value: "fast", label: "快速" },
              { value: "deep", label: "深入" },
            ],
          }),
          expect.objectContaining({ type: "secret", required: true }),
        ]),
      }),
    );
  });

  it("rejects duplicate keys and invalid enum defaults", () => {
    expect(() => buildConfigurationSchema([field(1, { key: "same" }), field(2, { key: "same" })])).toThrow(
      "配置键重复",
    );
    expect(() =>
      buildConfigurationSchema([field(1, { type: "select", options: "fast=快速", defaultValue: "missing" })]),
    ).toThrow("默认值不在枚举选项中");
  });
});
