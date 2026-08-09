import { describe, expect, it } from "vitest";
import {
  clonePluginConfigurationSchema,
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

  it("parses model-selector widget metadata", () => {
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
      ],
    });
    expect(schema?.fields[0]).toEqual(expect.objectContaining({ widget: "model-selector", modelFormat: "model-id" }));
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", modelFormat: "model-id" }],
      }),
    ).toThrow("metadata is invalid");
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

  it("parses and normalizes grouping, ordering, deprecation, pattern, and option description metadata", () => {
    const schema = parsePluginConfigurationSchema({
      version: 1,
      fields: [
        {
          key: "name",
          label: "Name",
          type: "text",
          group: "General",
          order: 1,
          pattern: "^[a-z]+$",
          patternMessage: "Name只能包含小写字母",
        },
        {
          key: "oldMode",
          label: "Old Mode",
          type: "select",
          group: "Advanced",
          order: 2,
          deprecated: true,
          deprecatedMessage: "请改用 newMode",
          options: [{ value: "fast", label: "Fast", description: "优先响应速度" }],
        },
        { key: "token", label: "Token", type: "secret", pattern: "^sk-[a-z0-9]+$" },
        { key: "directory", label: "Directory", type: "path", pattern: "^/" },
        { key: "notes", label: "Notes", type: "textarea", pattern: "^.{0,200}$" },
      ],
    });

    expect(schema?.fields).toEqual([
      expect.objectContaining({
        key: "name",
        group: "General",
        order: 1,
        pattern: "^[a-z]+$",
        patternMessage: "Name只能包含小写字母",
      }),
      expect.objectContaining({
        key: "oldMode",
        group: "Advanced",
        order: 2,
        deprecated: true,
        deprecatedMessage: "请改用 newMode",
        options: [{ value: "fast", label: "Fast", description: "优先响应速度" }],
      }),
      expect.objectContaining({ key: "token", pattern: "^sk-[a-z0-9]+$" }),
      expect.objectContaining({ key: "directory", pattern: "^/" }),
      expect.objectContaining({ key: "notes", pattern: "^.{0,200}$" }),
    ]);
  });

  it("rejects an invalid pattern regex", () => {
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", pattern: "[" }],
      }),
    ).toThrow("pattern is invalid");
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
  it("rejects values that do not match the field pattern and uses the pattern message", () => {
    const field = {
      key: "name",
      label: "Name",
      type: "text" as const,
      pattern: "^[a-z]+$",
      patternMessage: "Name只能包含小写字母",
    };
    const error = validatePluginConfigurationValue(field, "UPPER");
    expect(error?.code).toBe("pattern");
    expect(error?.message).toBe("Name只能包含小写字母");
    const fallback = validatePluginConfigurationValue({ ...field, patternMessage: undefined }, "UPPER");
    expect(fallback?.code).toBe("pattern");
    expect(fallback?.message).toBe("Name不符合要求");
  });

  it("accepts values that match the field pattern and skips empty optional values", () => {
    const field = {
      key: "name",
      label: "Name",
      type: "text" as const,
      pattern: "^[a-z]+$",
      patternMessage: "Name只能包含小写字母",
    };
    expect(validatePluginConfigurationValue(field, "lower")).toBeUndefined();
    expect(validatePluginConfigurationValue(field, "")).toBeUndefined();
    expect(validatePluginConfigurationValue(field, undefined)).toBeUndefined();
  });

  it("rejects out-of-bounds metadata and still rejects unknown properties", () => {
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", order: -1 }],
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", order: 1.5 }],
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", order: 100_001 }],
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", group: "x".repeat(65) }],
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", deprecatedMessage: "x".repeat(241) }],
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", pattern: "x".repeat(513) }],
      }),
    ).toThrow("text is invalid");
    expect(() =>
      parsePluginConfigurationSchema({
        version: 1,
        fields: [{ key: "name", label: "Name", type: "text", patternMessage: "x".repeat(241) }],
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
        fields: [{ key: "name", label: "Name", type: "text", weight: 1 }],
      }),
    ).toThrow("unsupported property");
  });

  it("clones the new metadata fields", () => {
    const schema = parsePluginConfigurationSchema({
      version: 1,
      fields: [
        {
          key: "name",
          label: "Name",
          type: "text",
          group: "General",
          order: 1,
          deprecated: false,
          deprecatedMessage: "旧字段",
          pattern: "^[a-z]+$",
          patternMessage: "Name只能包含小写字母",
        },
        {
          key: "mode",
          label: "Mode",
          type: "select",
          options: [{ value: "fast", label: "Fast", description: "优先响应速度" }],
        },
      ],
    })!;
    const cloned = clonePluginConfigurationSchema(schema);
    expect(cloned.fields[0]).toEqual(schema.fields[0]);
    expect(cloned.fields[1]).toEqual(schema.fields[1]);
    expect(cloned.fields[1]).not.toBe(schema.fields[1]);
    expect(cloned.fields[1].options[0]).not.toBe(schema.fields[1].options[0]);
    const option = cloned.fields[1].options[0] as { value: string; label: string; description?: string };
    expect(option.description).toBe("优先响应速度");
  });
});
