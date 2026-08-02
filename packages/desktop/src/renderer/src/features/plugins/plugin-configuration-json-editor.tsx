import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PluginConfigurationSchema,
  type PluginConfigurationValue,
  validatePluginConfigurationValue,
} from "../../../../shared/plugin-configuration-contracts.ts";
import type { PluginConfigurationController } from "./use-plugin-configuration.ts";

export type PluginConfigurationJsonParseResult =
  | { ok: true; values: Record<string, PluginConfigurationValue> }
  | { ok: false; error: string };

export function parsePluginConfigurationJson(
  text: string,
  schema: PluginConfigurationSchema,
): PluginConfigurationJsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON 配置必须是对象" };
  }
  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]));
  const values: Record<string, PluginConfigurationValue> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const field = fieldsByKey.get(key);
    if (!field) return { ok: false, error: `JSON 配置包含未知字段：${key}` };
    if (field.type === "secret") return { ok: false, error: `字段 ${key} 是敏感字段，请在表单模式中管理` };
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, error: `字段 ${key} 的值必须是文本、数字或开关值` };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { ok: false, error: `字段 ${key} 必须是有限数字` };
    }
    values[key] = value;
  }
  // 与服务端一致：缺失字段回退到默认值后再校验
  for (const field of schema.fields) {
    if (field.type === "secret") continue;
    const error = validatePluginConfigurationValue(field, values[field.key] ?? field.defaultValue);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true, values };
}

export function PluginConfigurationJsonEditor({
  controller,
  saveRequest,
}: {
  controller: PluginConfigurationController;
  saveRequest: number;
}) {
  const [text, setText] = useState(() => formatConfigurationJson(controller.effectiveValues));
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const effectiveJson = formatConfigurationJson(controller.effectiveValues);

  // 快照变化（保存成功或冲突更新）后，从 effectiveValues 重新生成编辑器文本
  useEffect(() => {
    setText(effectiveJson);
    setError(undefined);
  }, [effectiveJson]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  const handleSave = useCallback(async () => {
    if (!controller.snapshot || controller.saving) return;
    const parsed = parsePluginConfigurationJson(text, controller.snapshot.schema);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    await controller.saveJsonValues(parsed.values);
  }, [controller, text]);

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  useEffect(() => {
    if (saveRequest === 0) return;
    void handleSaveRef.current();
  }, [saveRequest]);

  return (
    <div className="plugin-configuration-json-editor">
      <textarea
        ref={textareaRef}
        className="plugin-configuration-json-editor-textarea"
        value={text}
        spellCheck={false}
        aria-label="插件配置 JSON"
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <span className="plugin-configuration-json-editor-note">
        secret 字段不会在 JSON 模式中显示或修改（请在表单模式中管理敏感字段）
      </span>
      {error ? (
        <span className="plugin-configuration-json-editor-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function formatConfigurationJson(values: Record<string, PluginConfigurationValue>): string {
  return JSON.stringify(values, null, 2);
}
