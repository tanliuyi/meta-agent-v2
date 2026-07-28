import { Plus, Trash2 } from "lucide-react";
import type { PluginConfigurationField, PluginConfigurationSchema } from "@/api.ts";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export type ConfigurationFieldType = PluginConfigurationField["type"];

export interface ConfigurationFieldDraft {
  id: number;
  type: ConfigurationFieldType;
  key: string;
  label: string;
  description: string;
  required: boolean;
  defaultValue: string;
  placeholder: string;
  minimum: string;
  maximum: string;
  step: string;
  minLength: string;
  maxLength: string;
  options: string;
}

const FIELD_TYPES: Array<{ value: ConfigurationFieldType; label: string }> = [
  { value: "text", label: "单行文本" },
  { value: "textarea", label: "多行文本" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "布尔值" },
  { value: "select", label: "枚举" },
  { value: "secret", label: "密钥" },
  { value: "path", label: "路径" },
];

export function createConfigurationFieldDraft(id: number): ConfigurationFieldDraft {
  return {
    id,
    type: "text",
    key: "",
    label: "",
    description: "",
    required: false,
    defaultValue: "",
    placeholder: "",
    minimum: "",
    maximum: "",
    step: "",
    minLength: "",
    maxLength: "",
    options: "",
  };
}

export function ConfigurationSchemaBuilder({
  fields,
  onChange,
  onAdd,
}: {
  fields: ConfigurationFieldDraft[];
  onChange(fields: ConfigurationFieldDraft[]): void;
  onAdd(): void;
}) {
  function update(id: number, patch: Partial<ConfigurationFieldDraft>): void {
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  }

  return (
    <section className="grid gap-3" aria-labelledby="configuration-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="configuration-heading" className="text-sm font-medium">
            可视化配置
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">字段由 Desktop 原生渲染，插件无法注入前端代码。</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus />
          添加字段
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="border-y py-6 text-center text-sm text-muted-foreground">此版本不需要用户配置</div>
      ) : (
        <div className="divide-y border-y">
          {fields.map((field, index) => (
            <fieldset className="grid gap-4 py-4" key={field.id}>
              <legend className="sr-only">配置字段 {index + 1}</legend>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">字段 {index + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`删除字段 ${index + 1}`}
                  onClick={() => onChange(fields.filter((item) => item.id !== field.id))}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="字段类型" htmlFor={`configuration-type-${field.id}`}>
                  <Select
                    value={field.type}
                    onValueChange={(value) => update(field.id, { type: value as ConfigurationFieldType })}
                  >
                    <SelectTrigger id={`configuration-type-${field.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem value={type.value} key={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="配置键" htmlFor={`configuration-key-${field.id}`}>
                  <Input
                    id={`configuration-key-${field.id}`}
                    required
                    maxLength={64}
                    placeholder="apiKey"
                    value={field.key}
                    onChange={(event) => update(field.id, { key: event.target.value })}
                  />
                </Field>
                <Field label="显示名称" htmlFor={`configuration-label-${field.id}`}>
                  <Input
                    id={`configuration-label-${field.id}`}
                    required
                    maxLength={120}
                    placeholder="API 密钥"
                    value={field.label}
                    onChange={(event) => update(field.id, { label: event.target.value })}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Field label="说明" htmlFor={`configuration-description-${field.id}`}>
                  <Input
                    id={`configuration-description-${field.id}`}
                    maxLength={1000}
                    value={field.description}
                    onChange={(event) => update(field.id, { description: event.target.value })}
                  />
                </Field>
                <label
                  htmlFor={`configuration-required-${field.id}`}
                  className="flex h-9 items-center gap-2 self-end text-sm"
                >
                  <Checkbox
                    id={`configuration-required-${field.id}`}
                    checked={field.required}
                    onCheckedChange={(checked) => update(field.id, { required: checked === true })}
                  />
                  必填
                </label>
              </div>
              <FieldConstraints field={field} onChange={(patch) => update(field.id, patch)} />
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}

function FieldConstraints({
  field,
  onChange,
}: {
  field: ConfigurationFieldDraft;
  onChange(patch: Partial<ConfigurationFieldDraft>): void;
}) {
  if (field.type === "boolean") {
    return (
      <Field label="默认值" htmlFor={`configuration-default-${field.id}`}>
        <Select
          value={field.defaultValue || "unset"}
          onValueChange={(value) => onChange({ defaultValue: value === "unset" ? "" : value })}
        >
          <SelectTrigger id={`configuration-default-${field.id}`} className="sm:max-w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unset">未设置</SelectItem>
            <SelectItem value="true">开启</SelectItem>
            <SelectItem value="false">关闭</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    );
  }
  if (field.type === "select") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="枚举选项" htmlFor={`configuration-options-${field.id}`} hint="每行格式：值=显示名称">
          <Textarea
            id={`configuration-options-${field.id}`}
            required
            rows={3}
            placeholder={"fast=快速\nbalanced=均衡"}
            value={field.options}
            onChange={(event) => onChange({ options: event.target.value })}
          />
        </Field>
        <Field label="默认值" htmlFor={`configuration-default-${field.id}`} hint="填写枚举值，可选">
          <Input
            id={`configuration-default-${field.id}`}
            value={field.defaultValue}
            onChange={(event) => onChange({ defaultValue: event.target.value })}
          />
        </Field>
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <div className="grid gap-4 sm:grid-cols-4">
        <NumericField field={field} property="defaultValue" label="默认值" onChange={onChange} />
        <NumericField field={field} property="minimum" label="最小值" onChange={onChange} />
        <NumericField field={field} property="maximum" label="最大值" onChange={onChange} />
        <NumericField field={field} property="step" label="步长" onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <Field label="占位提示" htmlFor={`configuration-placeholder-${field.id}`}>
        <Input
          id={`configuration-placeholder-${field.id}`}
          value={field.placeholder}
          onChange={(event) => onChange({ placeholder: event.target.value })}
        />
      </Field>
      {field.type !== "secret" ? (
        <Field label="默认值" htmlFor={`configuration-default-${field.id}`}>
          <Input
            id={`configuration-default-${field.id}`}
            value={field.defaultValue}
            onChange={(event) => onChange({ defaultValue: event.target.value })}
          />
        </Field>
      ) : null}
      <NumericField field={field} property="minLength" label="最短长度" onChange={onChange} />
      <NumericField field={field} property="maxLength" label="最长长度" onChange={onChange} />
    </div>
  );
}

function NumericField({
  field,
  property,
  label,
  onChange,
}: {
  field: ConfigurationFieldDraft;
  property: "defaultValue" | "minimum" | "maximum" | "step" | "minLength" | "maxLength";
  label: string;
  onChange(patch: Partial<ConfigurationFieldDraft>): void;
}) {
  return (
    <Field label={label} htmlFor={`configuration-${property}-${field.id}`}>
      <Input
        id={`configuration-${property}-${field.id}`}
        type="number"
        value={field[property]}
        onChange={(event) => onChange({ [property]: event.target.value })}
      />
    </Field>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function buildConfigurationSchema(fields: ConfigurationFieldDraft[]): PluginConfigurationSchema | undefined {
  if (fields.length === 0) return undefined;
  const keys = new Set<string>();
  const parsed = fields.map((field) => {
    const key = field.key.trim();
    const label = field.label.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new Error(`配置键无效：${key || "未填写"}`);
    if (keys.has(key)) throw new Error(`配置键重复：${key}`);
    if (!label) throw new Error(`配置项 ${key} 缺少显示名称`);
    keys.add(key);
    const base = {
      key,
      label,
      ...(field.description.trim() ? { description: field.description.trim() } : {}),
      ...(field.required ? { required: true } : {}),
    };
    if (field.type === "boolean") {
      return {
        ...base,
        type: "boolean" as const,
        ...(field.defaultValue ? { defaultValue: field.defaultValue === "true" } : {}),
      };
    }
    if (field.type === "number") {
      return {
        ...base,
        type: "number" as const,
        ...optionalNumberProperties(field, ["defaultValue", "minimum", "maximum", "step"]),
      };
    }
    if (field.type === "select") {
      const options = parseOptions(field.options, key);
      if (field.defaultValue && !options.some((option) => option.value === field.defaultValue.trim())) {
        throw new Error(`配置项 ${key} 的默认值不在枚举选项中`);
      }
      return {
        ...base,
        type: "select" as const,
        options,
        ...(field.defaultValue.trim() ? { defaultValue: field.defaultValue.trim() } : {}),
      };
    }
    const textValues = {
      ...(field.type !== "secret" && field.defaultValue ? { defaultValue: field.defaultValue } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...optionalNumberProperties(field, ["minLength", "maxLength"]),
    };
    return { ...base, type: field.type, ...textValues } as PluginConfigurationField;
  });
  return { version: 1, fields: parsed };
}

function optionalNumberProperties(
  field: ConfigurationFieldDraft,
  properties: Array<"defaultValue" | "minimum" | "maximum" | "step" | "minLength" | "maxLength">,
): Record<string, number> {
  return Object.fromEntries(
    properties.flatMap((property) => {
      const source = field[property].trim();
      if (!source) return [];
      const value = Number(source);
      if (!Number.isFinite(value)) throw new Error(`配置项 ${field.key || field.label} 的数值无效`);
      return [[property, value]];
    }),
  );
}

function parseOptions(source: string, key: string): Array<{ value: string; label: string }> {
  const options = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      const value = (separator === -1 ? line : line.slice(0, separator)).trim();
      const label = (separator === -1 ? line : line.slice(separator + 1)).trim();
      if (!value || !label) throw new Error(`配置项 ${key} 的枚举格式无效`);
      return { value, label };
    });
  if (options.length === 0) throw new Error(`配置项 ${key} 至少需要一个枚举选项`);
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new Error(`配置项 ${key} 的枚举值重复`);
  }
  return options;
}
