import { describe, expect, it } from "vitest";
import {
  parsePluginConfigurationSchema,
  validatePluginConfigurationValue,
} from "../src/shared/plugin-configuration-contracts.ts";

describe("plugin configuration schema", () => {
  it("normalizes the supported declarative field types", () => {
    const schema = parsePluginConfigurationSchema({
      version: 1,
      fields: [
        { key: "name", label: "Name", type: "text", required: true, maxLength: 100 },
        { key: "notes", label: "Notes", type: "textarea" },
        { key: "directory", label: "Directory", type: "path" },
        { key: "token", label: "Token", type: "secret", minLength: 8 },
        { key: "retries", label: "Retries", type: "number", minimum: 0, maximum: 5, step: 1 },
        { key: "enabled", label: "Enabled", type: "boolean", defaultValue: true },
        {
          key: "mode",
          label: "Mode",
          type: "select",
          options: [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ],
        },
      ],
    });

    expect(schema?.fields.map((field) => field.type)).toEqual([
      "text",
      "textarea",
      "path",
      "secret",
      "number",
      "boolean",
      "select",
    ]);
  });

  it("rejects duplicate keys, unsupported properties, and invalid defaults", () => {
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [
          { key: "same", label: "One", type: "text" },
          { key: "same", label: "Two", type: "text" },
        ],
      }),
    ).toThrow("duplicated");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", component: "script" }],
      }),
    ).toThrow("unsupported property");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [
          {
            key: "mode",
            label: "Mode",
            type: "select",
            defaultValue: "missing",
            options: [{ value: "safe", label: "Safe" }],
          },
        ],
      }),
    ).toThrow("default is invalid");
  });

  it("returns stable field-level value validation", () => {
    const field = {
      key: "count",
      label: "Count",
      type: "number" as const,
      required: true,
      minimum: 1,
      maximum: 3,
    };
    expect(validatePluginConfigurationValue(field, undefined)?.code).toBe("required");
    expect(validatePluginConfigurationValue(field, 0)?.code).toBe("minimum");
    expect(validatePluginConfigurationValue(field, 4)?.code).toBe("maximum");
    expect(validatePluginConfigurationValue(field, 2)).toBeUndefined();
  });
});
