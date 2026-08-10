import safeRegex from "safe-regex2";

export type PluginConfigurationValue = string | number | boolean;

interface PluginConfigurationFieldBase {
  key: string;
  label: string;
  description?: string;
  group?: string;
  order?: number;
  deprecated?: boolean;
  deprecatedMessage?: string;
  required?: boolean;
  widget?: "model-selector";
  modelFormat?: "model-id" | "provider-model";
}

export interface PluginTextConfigurationField extends PluginConfigurationFieldBase {
  type: "text" | "textarea" | "path";
  defaultValue?: string;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
}

export interface PluginSecretConfigurationField extends PluginConfigurationFieldBase {
  type: "secret";
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
}

export interface PluginNumberConfigurationField extends PluginConfigurationFieldBase {
  type: "number";
  defaultValue?: number;
  minimum?: number;
  maximum?: number;
  step?: number;
}

export interface PluginBooleanConfigurationField extends PluginConfigurationFieldBase {
  type: "boolean";
  defaultValue?: boolean;
}

export interface PluginSelectConfigurationField extends PluginConfigurationFieldBase {
  type: "select";
  defaultValue?: string;
  options: Array<{ value: string; label: string; description?: string }>;
}

export type PluginConfigurationField =
  | PluginTextConfigurationField
  | PluginSecretConfigurationField
  | PluginNumberConfigurationField
  | PluginBooleanConfigurationField
  | PluginSelectConfigurationField;

export interface PluginConfigurationSchema {
  version: 1;
  fields: PluginConfigurationField[];
}

export interface PluginConfigurationFieldError {
  field: string;
  code:
    | "required"
    | "type"
    | "minimum"
    | "maximum"
    | "step"
    | "min-length"
    | "max-length"
    | "pattern"
    | "option"
    | "secret-storage";
  message: string;
}

export interface PluginConfigurationSnapshot {
  pluginId: string;
  revision: string;
  schema: PluginConfigurationSchema;
  values: Record<string, PluginConfigurationValue>;
  secrets: Record<string, boolean>;
  secretStorageAvailable: boolean;
}

export interface SavePluginConfigurationInput {
  requestId: string;
  pluginId: string;
  expectedRevision: string;
  values: Record<string, PluginConfigurationValue>;
  secretValues?: Record<string, string>;
  clearSecrets?: string[];
}

export type SavePluginConfigurationResult =
  | { status: "saved"; snapshot: PluginConfigurationSnapshot }
  | { status: "conflict"; current: PluginConfigurationSnapshot }
  | { status: "invalid"; snapshot: PluginConfigurationSnapshot; errors: PluginConfigurationFieldError[] };

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const MAX_FIELDS = 64;
const MAX_LABEL_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_PLACEHOLDER_LENGTH = 240;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_OPTIONS = 100;
const MAX_GROUP_LENGTH = 64;
const MAX_ORDER = 100_000;
const MAX_DEPRECATED_MESSAGE_LENGTH = 240;
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_MESSAGE_LENGTH = 240;
const MAX_OPTION_DESCRIPTION_LENGTH = 240;

export function parsePluginConfigurationSchema(value: unknown): PluginConfigurationSchema | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.fields)) {
    throw new Error("Plugin configuration schema is invalid");
  }
  assertAllowedKeys(value, new Set(["version", "fields"]), "configuration schema");
  if (value.fields.length > MAX_FIELDS) throw new Error("Plugin configuration schema has too many fields");
  const fields = value.fields.map(parseField);
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) throw new Error(`Plugin configuration field is duplicated: ${field.key}`);
    keys.add(field.key);
  }
  return { version: 1, fields };
}

export function clonePluginConfigurationSchema(schema: PluginConfigurationSchema): PluginConfigurationSchema {
  return {
    version: 1,
    fields: schema.fields.map((field) =>
      field.type === "select" ? { ...field, options: field.options.map((option) => ({ ...option })) } : { ...field },
    ),
  };
}

export function defaultPluginConfigurationValues(
  schema: PluginConfigurationSchema,
): Record<string, PluginConfigurationValue> {
  const values: Record<string, PluginConfigurationValue> = {};
  for (const field of schema.fields) {
    if (field.type === "secret" || field.defaultValue === undefined) continue;
    values[field.key] = field.defaultValue;
  }
  return values;
}

export function validatePluginConfigurationValue(
  field: PluginConfigurationField,
  value: unknown,
  secretConfigured = false,
): PluginConfigurationFieldError | undefined {
  if (field.type === "boolean") {
    if (value === undefined) {
      return field.required ? fieldError(field, "required", `${field.label}为必填项`) : undefined;
    }
    return typeof value === "boolean" ? undefined : fieldError(field, "type", `${field.label}必须是开关值`);
  }
  if (field.type === "number") {
    if (value === undefined) {
      return field.required ? fieldError(field, "required", `${field.label}为必填项`) : undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fieldError(field, "type", `${field.label}必须是有限数字`);
    }
    if (field.minimum !== undefined && value < field.minimum) {
      return fieldError(field, "minimum", `${field.label}不能小于 ${field.minimum}`);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      return fieldError(field, "maximum", `${field.label}不能大于 ${field.maximum}`);
    }
    if (field.step !== undefined) {
      const quotient = (value - (field.minimum ?? 0)) / field.step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        return fieldError(field, "step", `${field.label}必须按 ${field.step} 递增`);
      }
    }
    return undefined;
  }
  if (field.type === "secret" && value === undefined) {
    return field.required && !secretConfigured ? fieldError(field, "required", `${field.label}为必填项`) : undefined;
  }
  if (value === undefined) {
    return field.required ? fieldError(field, "required", `${field.label}为必填项`) : undefined;
  }
  if (typeof value !== "string") return fieldError(field, "type", `${field.label}必须是文本`);
  if (field.required && value.length === 0) return fieldError(field, "required", `${field.label}为必填项`);
  if (field.type === "select") {
    return field.options.some((option) => option.value === value)
      ? undefined
      : fieldError(field, "option", `${field.label}包含无效选项`);
  }
  if (field.minLength !== undefined && value.length < field.minLength) {
    return fieldError(field, "min-length", `${field.label}至少需要 ${field.minLength} 个字符`);
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return fieldError(field, "max-length", `${field.label}最多允许 ${field.maxLength} 个字符`);
  }
  if (field.pattern !== undefined && value.length > 0) {
    if (!safeRegex(field.pattern) || !new RegExp(field.pattern).test(value)) {
      return fieldError(field, "pattern", field.patternMessage ?? `${field.label}不符合要求`);
    }
  }
  return undefined;
}

function parseField(value: unknown): PluginConfigurationField {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw new Error("Plugin configuration field is invalid");
  }
  const base = parseFieldBase(value);
  if (value.type === "boolean") {
    assertAllowedKeys(value, new Set([...baseKeys(), "defaultValue"]), `configuration field ${base.key}`);
    if (value.defaultValue !== undefined && typeof value.defaultValue !== "boolean") {
      throw new Error(`Plugin configuration field default is invalid: ${base.key}`);
    }
    return {
      ...base,
      type: "boolean",
      ...(value.defaultValue === undefined ? {} : { defaultValue: value.defaultValue }),
    };
  }
  if (value.type === "number") {
    assertAllowedKeys(
      value,
      new Set([...baseKeys(), "defaultValue", "minimum", "maximum", "step"]),
      `configuration field ${base.key}`,
    );
    const defaultValue = optionalFiniteNumber(value.defaultValue, base.key);
    const minimum = optionalFiniteNumber(value.minimum, base.key);
    const maximum = optionalFiniteNumber(value.maximum, base.key);
    const step = optionalFiniteNumber(value.step, base.key);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`Plugin configuration field range is invalid: ${base.key}`);
    }
    if (step !== undefined && step <= 0) throw new Error(`Plugin configuration field step is invalid: ${base.key}`);
    if (
      defaultValue !== undefined &&
      ((minimum !== undefined && defaultValue < minimum) || (maximum !== undefined && defaultValue > maximum))
    ) {
      throw new Error(`Plugin configuration field default is outside its range: ${base.key}`);
    }
    const field: PluginNumberConfigurationField = {
      ...base,
      type: "number",
      ...defined({ defaultValue, minimum, maximum, step }),
    };
    if (defaultValue !== undefined && validatePluginConfigurationValue(field, defaultValue)) {
      throw new Error(`Plugin configuration field default does not match its step: ${base.key}`);
    }
    return field;
  }
  if (value.type === "select") {
    assertAllowedKeys(value, new Set([...baseKeys(), "defaultValue", "options"]), `configuration field ${base.key}`);
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_OPTIONS) {
      throw new Error(`Plugin configuration field options are invalid: ${base.key}`);
    }
    const optionValues = new Set<string>();
    const options = value.options.map((option) => {
      if (
        !isPlainObject(option) ||
        typeof option.value !== "string" ||
        option.value.length === 0 ||
        option.value.length > 240 ||
        typeof option.label !== "string" ||
        option.label.length === 0 ||
        option.label.length > MAX_LABEL_LENGTH ||
        (option.description !== undefined &&
          (typeof option.description !== "string" || option.description.length > MAX_OPTION_DESCRIPTION_LENGTH))
      ) {
        throw new Error(`Plugin configuration field option is invalid: ${base.key}`);
      }
      assertAllowedKeys(option, new Set(["value", "label", "description"]), `configuration option ${base.key}`);
      if (optionValues.has(option.value)) throw new Error(`Plugin configuration option is duplicated: ${base.key}`);
      optionValues.add(option.value);
      return {
        value: option.value,
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      };
    });
    if (
      value.defaultValue !== undefined &&
      (typeof value.defaultValue !== "string" || !optionValues.has(value.defaultValue))
    ) {
      throw new Error(`Plugin configuration field default is invalid: ${base.key}`);
    }
    return {
      ...base,
      type: "select",
      options,
      ...(value.defaultValue === undefined ? {} : { defaultValue: value.defaultValue }),
    };
  }
  if (value.type === "text" || value.type === "textarea" || value.type === "path" || value.type === "secret") {
    assertAllowedKeys(
      value,
      new Set([
        ...baseKeys(),
        ...(value.type === "secret" ? [] : ["defaultValue"]),
        "placeholder",
        "minLength",
        "maxLength",
        "pattern",
        "patternMessage",
      ]),
      `configuration field ${base.key}`,
    );
    const placeholder = optionalBoundedString(value.placeholder, MAX_PLACEHOLDER_LENGTH, base.key);
    const minLength = optionalBoundedInteger(value.minLength, 0, MAX_TEXT_LENGTH, base.key);
    const maxLength = optionalBoundedInteger(value.maxLength, 1, MAX_TEXT_LENGTH, base.key);
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new Error(`Plugin configuration field length range is invalid: ${base.key}`);
    }
    const pattern = optionalBoundedString(value.pattern, MAX_PATTERN_LENGTH, base.key);
    if (pattern !== undefined) {
      try {
        if (!safeRegex(pattern)) throw new Error("unsafe pattern");
        new RegExp(pattern);
      } catch {
        throw new Error(`Plugin configuration field pattern is invalid: ${base.key}`);
      }
    }
    const patternMessage = optionalBoundedString(value.patternMessage, MAX_PATTERN_MESSAGE_LENGTH, base.key);
    if (value.type === "secret") {
      return { ...base, type: "secret", ...defined({ placeholder, minLength, maxLength, pattern, patternMessage }) };
    }
    const defaultValue = optionalBoundedString(value.defaultValue, maxLength ?? MAX_TEXT_LENGTH, base.key);
    if (defaultValue !== undefined && minLength !== undefined && defaultValue.length < minLength) {
      throw new Error(`Plugin configuration field default is too short: ${base.key}`);
    }
    if (
      defaultValue !== undefined &&
      defaultValue.length > 0 &&
      pattern !== undefined &&
      !new RegExp(pattern).test(defaultValue)
    ) {
      throw new Error(`Plugin configuration field default does not match its pattern: ${base.key}`);
    }
    return {
      ...base,
      type: value.type,
      ...defined({ defaultValue, placeholder, minLength, maxLength, pattern, patternMessage }),
    };
  }
  throw new Error(`Plugin configuration field type is unsupported: ${value.type}`);
}

function parseFieldBase(value: Record<string, unknown>): PluginConfigurationFieldBase {
  if (
    typeof value.key !== "string" ||
    !FIELD_KEY.test(value.key) ||
    value.key === "__proto__" ||
    value.key === "prototype" ||
    value.key === "constructor" ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > MAX_LABEL_LENGTH ||
    (value.description !== undefined &&
      (typeof value.description !== "string" || value.description.length > MAX_DESCRIPTION_LENGTH)) ||
    (value.group !== undefined && (typeof value.group !== "string" || value.group.length > MAX_GROUP_LENGTH)) ||
    (value.order !== undefined &&
      (typeof value.order !== "number" ||
        !Number.isSafeInteger(value.order) ||
        value.order < 0 ||
        value.order > MAX_ORDER)) ||
    (value.deprecated !== undefined && typeof value.deprecated !== "boolean") ||
    (value.deprecatedMessage !== undefined &&
      (typeof value.deprecatedMessage !== "string" ||
        value.deprecatedMessage.length > MAX_DEPRECATED_MESSAGE_LENGTH)) ||
    (value.required !== undefined && typeof value.required !== "boolean") ||
    (value.widget !== undefined && value.widget !== "model-selector") ||
    (value.modelFormat !== undefined &&
      (value.widget !== "model-selector" ||
        (value.modelFormat !== "model-id" && value.modelFormat !== "provider-model")))
  ) {
    throw new Error("Plugin configuration field metadata is invalid");
  }
  return {
    key: value.key,
    label: value.label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.group === "string" ? { group: value.group } : {}),
    ...(typeof value.order === "number" ? { order: value.order } : {}),
    ...(typeof value.deprecated === "boolean" ? { deprecated: value.deprecated } : {}),
    ...(typeof value.deprecatedMessage === "string" ? { deprecatedMessage: value.deprecatedMessage } : {}),
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
    ...(value.widget === "model-selector" ? { widget: value.widget } : {}),
    ...(value.modelFormat === "model-id" || value.modelFormat === "provider-model"
      ? { modelFormat: value.modelFormat }
      : {}),
  };
}

function fieldError(
  field: PluginConfigurationField,
  code: PluginConfigurationFieldError["code"],
  message: string,
): PluginConfigurationFieldError {
  return { field: field.key, code, message };
}

function baseKeys(): string[] {
  return [
    "key",
    "label",
    "description",
    "group",
    "order",
    "deprecated",
    "deprecatedMessage",
    "required",
    "widget",
    "modelFormat",
    "type",
  ];
}

function optionalFiniteNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Plugin configuration field number is invalid: ${key}`);
  }
  return value;
}

function optionalBoundedInteger(value: unknown, minimum: number, maximum: number, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Plugin configuration field length is invalid: ${key}`);
  }
  return value as number;
}

function optionalBoundedString(value: unknown, maximum: number, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`Plugin configuration field text is invalid: ${key}`);
  }
  return value;
}

function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Plugin ${label} contains an unsupported property: ${unknown}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
