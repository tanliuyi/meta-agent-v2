import type { PluginConfigurationField, PluginConfigurationSchema } from "./contracts.ts";

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const TEXT_TYPES = new Set(["text", "textarea", "path", "secret"]);
const BASE_KEYS = ["key", "label", "description", "required", "type"];

/** 市场只接收声明式字段，拒绝未知属性，从协议层阻断任意前端代码注入。 */
export function parsePluginConfigurationSchema(value: unknown): PluginConfigurationSchema | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value) || value.version !== 1 || !Array.isArray(value.fields) || value.fields.length > 64) {
		throw new Error("configuration must be a version 1 schema with at most 64 fields");
	}
	assertKeys(value, ["version", "fields"]);
	const fields = value.fields.map(parseField);
	if (new Set(fields.map((field) => field.key)).size !== fields.length) {
		throw new Error("configuration field keys must be unique");
	}
	return { version: 1, fields };
}

function parseField(value: unknown): PluginConfigurationField {
	if (!isObject(value) || typeof value.type !== "string") throw new Error("configuration field is invalid");
	const base = parseBase(value);
	if (value.type === "boolean") {
		assertKeys(value, [...BASE_KEYS, "defaultValue"]);
		if (value.defaultValue !== undefined && typeof value.defaultValue !== "boolean") {
			throw new Error(`configuration default is invalid: ${base.key}`);
		}
		return { ...base, type: "boolean", ...defined({ defaultValue: value.defaultValue }) };
	}
	if (value.type === "number") {
		assertKeys(value, [...BASE_KEYS, "defaultValue", "minimum", "maximum", "step"]);
		const defaultValue = optionalNumber(value.defaultValue, base.key);
		const minimum = optionalNumber(value.minimum, base.key);
		const maximum = optionalNumber(value.maximum, base.key);
		const step = optionalNumber(value.step, base.key);
		if (minimum !== undefined && maximum !== undefined && minimum > maximum)
			throw new Error(`configuration range is invalid: ${base.key}`);
		if (step !== undefined && step <= 0) throw new Error(`configuration step is invalid: ${base.key}`);
		if (
			defaultValue !== undefined &&
			((minimum !== undefined && defaultValue < minimum) || (maximum !== undefined && defaultValue > maximum))
		) {
			throw new Error(`configuration default is outside its range: ${base.key}`);
		}
		if (defaultValue !== undefined && step !== undefined) {
			const quotient = (defaultValue - (minimum ?? 0)) / step;
			if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
				throw new Error(`configuration default does not match its step: ${base.key}`);
			}
		}
		return { ...base, type: "number", ...defined({ defaultValue, minimum, maximum, step }) };
	}
	if (value.type === "select") {
		assertKeys(value, [...BASE_KEYS, "defaultValue", "options"]);
		if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 100) {
			throw new Error(`configuration options are invalid: ${base.key}`);
		}
		const seen = new Set<string>();
		const options = value.options.map((option) => {
			if (
				!isObject(option) ||
				typeof option.value !== "string" ||
				option.value.length === 0 ||
				option.value.length > 240 ||
				typeof option.label !== "string" ||
				option.label.length === 0 ||
				option.label.length > 120
			) {
				throw new Error(`configuration option is invalid: ${base.key}`);
			}
			assertKeys(option, ["value", "label"]);
			if (seen.has(option.value)) throw new Error(`configuration option is duplicated: ${base.key}`);
			seen.add(option.value);
			return { value: option.value, label: option.label };
		});
		if (
			value.defaultValue !== undefined &&
			(typeof value.defaultValue !== "string" || !seen.has(value.defaultValue))
		) {
			throw new Error(`configuration default is invalid: ${base.key}`);
		}
		return { ...base, type: "select", options, ...defined({ defaultValue: value.defaultValue }) };
	}
	if (TEXT_TYPES.has(value.type)) {
		assertKeys(value, [
			...BASE_KEYS,
			...(value.type === "secret" ? [] : ["defaultValue"]),
			"placeholder",
			"minLength",
			"maxLength",
		]);
		const placeholder = optionalString(value.placeholder, 240, base.key);
		const minLength = optionalInteger(value.minLength, 0, 65_536, base.key);
		const maxLength = optionalInteger(value.maxLength, 1, 65_536, base.key);
		if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
			throw new Error(`configuration length range is invalid: ${base.key}`);
		if (value.type === "secret")
			return { ...base, type: "secret", ...defined({ placeholder, minLength, maxLength }) };
		const defaultValue = optionalString(value.defaultValue, maxLength ?? 65_536, base.key);
		if (defaultValue !== undefined && minLength !== undefined && defaultValue.length < minLength)
			throw new Error(`configuration default is too short: ${base.key}`);
		return {
			...base,
			type: value.type as "text" | "textarea" | "path",
			...defined({ defaultValue, placeholder, minLength, maxLength }),
		};
	}
	throw new Error(`configuration field type is unsupported: ${value.type}`);
}

function parseBase(value: Record<string, unknown>) {
	if (
		typeof value.key !== "string" ||
		!FIELD_KEY.test(value.key) ||
		["__proto__", "prototype", "constructor"].includes(value.key) ||
		typeof value.label !== "string" ||
		value.label.length === 0 ||
		value.label.length > 120 ||
		(value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1000)) ||
		(value.required !== undefined && typeof value.required !== "boolean")
	) {
		throw new Error("configuration field metadata is invalid");
	}
	return {
		key: value.key,
		label: value.label,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(typeof value.required === "boolean" ? { required: value.required } : {}),
	};
}

function optionalNumber(value: unknown, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`configuration number is invalid: ${key}`);
	return value;
}

function optionalInteger(value: unknown, minimum: number, maximum: number, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error(`configuration length is invalid: ${key}`);
	return value as number;
}

function optionalString(value: unknown, maximum: number, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maximum) throw new Error(`configuration text is invalid: ${key}`);
	return value;
}

function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
		[K in keyof T]?: Exclude<T[K], undefined>;
	};
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
	const set = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !set.has(key));
	if (unknown) throw new Error(`configuration contains an unsupported property: ${unknown}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
