import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultPluginConfigurationValues,
  type PluginConfigurationFieldError,
  type PluginConfigurationSnapshot,
  type PluginConfigurationValue,
} from "../../../../shared/plugin-configuration-contracts.ts";

export type PluginConfigurationDraftValue = string | boolean;

export type PluginConfigurationSource = "marketplace" | "development";

export interface PluginConfigurationController {
  snapshot?: PluginConfigurationSnapshot;
  values: Record<string, PluginConfigurationDraftValue>;
  effectiveValues: Record<string, PluginConfigurationValue>;
  secretValues: Record<string, string>;
  clearedSecrets: ReadonlySet<string>;
  fieldErrors: ReadonlyMap<string, string>;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error?: string;
  notice?: string;
  setValue(key: string, value: PluginConfigurationDraftValue): void;
  setSecretValue(key: string, value: string): void;
  clearSecret(key: string): void;
  resetField(key: string): void;
  save(): Promise<void>;
  saveJsonValues(values: Record<string, PluginConfigurationValue>): Promise<boolean>;
}

type PluginConfigurationJsonDraftResult =
  | { ok: true; draft: Record<string, PluginConfigurationDraftValue> }
  | { ok: false; error: string };

export function preparePluginConfigurationJsonDraft(
  snapshot: PluginConfigurationSnapshot,
  input: Record<string, PluginConfigurationValue>,
): PluginConfigurationJsonDraftResult {
  const fieldsByKey = new Map(snapshot.schema.fields.map((field) => [field.key, field]));
  const draft: Record<string, PluginConfigurationDraftValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = fieldsByKey.get(key);
    if (!field || field.type === "secret") {
      return {
        ok: false,
        error: field ? `字段 ${key} 是敏感字段，请在表单模式中管理` : `JSON 配置包含未知字段：${key}`,
      };
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, error: `字段 ${key} 的值必须是文本、数字或开关值` };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { ok: false, error: `字段 ${key} 必须是有限数字` };
    }
    draft[key] = field.type === "boolean" ? value === true : String(value);
  }
  return { ok: true, draft };
}

export function usePluginConfiguration(
  pluginId: string | undefined,
  source: PluginConfigurationSource = "marketplace",
): PluginConfigurationController {
  const [snapshot, setSnapshot] = useState<PluginConfigurationSnapshot>();
  const [values, setValues] = useState<Record<string, PluginConfigurationDraftValue>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(() => new Set());
  const [fieldErrors, setFieldErrors] = useState<Map<string, string>>(() => new Map());
  const [loading, setLoading] = useState(pluginId !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const mounted = useRef(true);

  const resetFromSnapshot = useCallback((next: PluginConfigurationSnapshot) => {
    setSnapshot(next);
    setValues(draftValues(next));
    setSecretValues({});
    setClearedSecrets(new Set());
    setFieldErrors(new Map());
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const request = ++generation.current;
    setError(undefined);
    setNotice(undefined);
    if (!pluginId) {
      setSnapshot(undefined);
      setValues({});
      setLoading(false);
      return;
    }
    setLoading(true);
    const getConfiguration =
      source === "development"
        ? window.desktop.extensions.getPluginConfiguration
        : window.desktop.marketplace.getPluginConfiguration;
    void getConfiguration(pluginId)
      .then((next) => {
        if (mounted.current && request === generation.current) resetFromSnapshot(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current && request === generation.current) setError(configurationErrorMessage(reason));
      })
      .finally(() => {
        if (mounted.current && request === generation.current) setLoading(false);
      });
  }, [pluginId, resetFromSnapshot, source]);

  const setValue = useCallback((key: string, value: PluginConfigurationDraftValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => withoutError(current, key));
    setNotice(undefined);
  }, []);

  const setSecretValue = useCallback((key: string, value: string) => {
    setSecretValues((current) => ({ ...current, [key]: value }));
    setClearedSecrets((current) => withoutKey(current, key));
    setFieldErrors((current) => withoutError(current, key));
    setNotice(undefined);
  }, []);

  const clearSecret = useCallback((key: string) => {
    setSecretValues((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setClearedSecrets((current) => new Set(current).add(key));
    setFieldErrors((current) => withoutError(current, key));
    setNotice(undefined);
  }, []);

  const effectiveValues = useMemo(() => {
    if (!snapshot) return {};
    return { ...defaultPluginConfigurationValues(snapshot.schema), ...snapshot.values };
  }, [snapshot]);

  const resetField = useCallback(
    (key: string) => {
      if (!snapshot) return;
      const field = snapshot.schema.fields.find((candidate) => candidate.key === key);
      if (!field || field.type === "secret") return;
      const defaultValue = field.defaultValue;
      setValues((current) => ({
        ...current,
        [key]:
          field.type === "boolean" ? defaultValue === true : defaultValue === undefined ? "" : String(defaultValue),
      }));
      setFieldErrors((current) => withoutError(current, key));
      setNotice(undefined);
    },
    [snapshot],
  );

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    return (
      JSON.stringify(values) !== JSON.stringify(draftValues(snapshot)) ||
      Object.values(secretValues).some((value) => value.length > 0) ||
      clearedSecrets.size > 0
    );
  }, [clearedSecrets, secretValues, snapshot, values]);

  const submitSave = useCallback(
    async (
      snapshot: PluginConfigurationSnapshot,
      values: Record<string, PluginConfigurationValue>,
    ): Promise<boolean> => {
      setSaving(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const saveConfiguration =
          source === "development"
            ? window.desktop.extensions.savePluginConfiguration
            : window.desktop.marketplace.savePluginConfiguration;
        const result = await saveConfiguration({
          requestId: crypto.randomUUID(),
          pluginId: snapshot.pluginId,
          expectedRevision: snapshot.revision,
          values,
          secretValues: Object.fromEntries(Object.entries(secretValues).filter((entry) => entry[1].length > 0)),
          clearSecrets: [...clearedSecrets],
        });
        if (!mounted.current) return false;
        if (result.status === "saved") {
          resetFromSnapshot(result.snapshot);
          setNotice("配置已保存，新会话将使用新配置");
          return true;
        }
        if (result.status === "conflict") {
          setSnapshot(result.current);
          setError("插件配置已在其他窗口中变化，请检查当前输入后重试");
          return false;
        }
        setSnapshot(result.snapshot);
        setFieldErrors(errorMap(result.errors));
        return false;
      } catch (reason) {
        if (mounted.current) setError(configurationErrorMessage(reason));
        return false;
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [clearedSecrets, resetFromSnapshot, secretValues, source],
  );

  const save = useCallback(async () => {
    if (!snapshot || saving || !dirty) return;
    const prepared = prepareValues(snapshot, values);
    if (prepared.errors.length > 0) {
      setFieldErrors(errorMap(prepared.errors));
      return;
    }
    await submitSave(snapshot, prepared.values);
  }, [dirty, saving, snapshot, submitSave, values]);

  const saveJsonValues = useCallback(
    async (input: Record<string, PluginConfigurationValue>): Promise<boolean> => {
      if (!snapshot || saving) return false;
      const preparedDraft = preparePluginConfigurationJsonDraft(snapshot, input);
      if (!preparedDraft.ok) {
        setError(preparedDraft.error);
        return false;
      }
      const draft = preparedDraft.draft;
      setValues(draft);
      setFieldErrors(new Map());
      const prepared = prepareValues(snapshot, draft);
      if (prepared.errors.length > 0) {
        setFieldErrors(errorMap(prepared.errors));
        return false;
      }
      return submitSave(snapshot, prepared.values);
    },
    [saving, snapshot, submitSave],
  );

  return {
    snapshot,
    values,
    effectiveValues,
    secretValues,
    clearedSecrets,
    fieldErrors,
    loading,
    saving,
    dirty,
    error,
    notice,
    setValue,
    setSecretValue,
    clearSecret,
    resetField,
    save,
    saveJsonValues,
  };
}

function draftValues(snapshot: PluginConfigurationSnapshot): Record<string, PluginConfigurationDraftValue> {
  const result: Record<string, PluginConfigurationDraftValue> = {};
  for (const field of snapshot.schema.fields) {
    if (field.type === "secret") continue;
    const value = snapshot.values[field.key];
    result[field.key] = field.type === "boolean" ? value === true : value === undefined ? "" : String(value);
  }
  return result;
}

function prepareValues(
  snapshot: PluginConfigurationSnapshot,
  draft: Record<string, PluginConfigurationDraftValue>,
): { values: Record<string, PluginConfigurationValue>; errors: PluginConfigurationFieldError[] } {
  const values: Record<string, PluginConfigurationValue> = {};
  const errors: PluginConfigurationFieldError[] = [];
  for (const field of snapshot.schema.fields) {
    if (field.type === "secret") continue;
    const value = draft[field.key];
    if (field.type === "boolean") {
      values[field.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (field.type === "select" && text.length === 0 && !field.required) continue;
    if (field.type === "number") {
      if (text.trim().length === 0) continue;
      const number = Number(text);
      if (!Number.isFinite(number)) {
        errors.push({ field: field.key, code: "type", message: `${field.label}必须是有限数字` });
      } else {
        values[field.key] = number;
      }
      continue;
    }
    values[field.key] = text;
  }
  return { values, errors };
}

function withoutError(current: Map<string, string>, key: string): Map<string, string> {
  if (!current.has(key)) return current;
  const next = new Map(current);
  next.delete(key);
  return next;
}

function withoutKey(current: Set<string>, key: string): Set<string> {
  if (!current.has(key)) return current;
  const next = new Set(current);
  next.delete(key);
  return next;
}

function errorMap(errors: PluginConfigurationFieldError[]): Map<string, string> {
  return new Map(errors.map((error) => [error.field, error.message]));
}

function configurationErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
}
