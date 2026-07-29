import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PluginConfigurationFieldError,
  PluginConfigurationSnapshot,
  PluginConfigurationValue,
} from "../../../../shared/plugin-configuration-contracts.ts";

export type PluginConfigurationDraftValue = string | boolean;

export interface PluginConfigurationController {
  snapshot?: PluginConfigurationSnapshot;
  values: Record<string, PluginConfigurationDraftValue>;
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
  save(): Promise<void>;
}

export function usePluginConfiguration(pluginId: string | undefined): PluginConfigurationController {
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
    void window.desktop.marketplace
      .getPluginConfiguration(pluginId)
      .then((next) => {
        if (mounted.current && request === generation.current) resetFromSnapshot(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current && request === generation.current) setError(configurationErrorMessage(reason));
      })
      .finally(() => {
        if (mounted.current && request === generation.current) setLoading(false);
      });
  }, [pluginId, resetFromSnapshot]);

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

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    return (
      JSON.stringify(values) !== JSON.stringify(draftValues(snapshot)) ||
      Object.values(secretValues).some((value) => value.length > 0) ||
      clearedSecrets.size > 0
    );
  }, [clearedSecrets, secretValues, snapshot, values]);

  const save = useCallback(async () => {
    if (!snapshot || saving || !dirty) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    const prepared = prepareValues(snapshot, values);
    if (prepared.errors.length > 0) {
      setFieldErrors(errorMap(prepared.errors));
      setSaving(false);
      return;
    }
    try {
      const result = await window.desktop.marketplace.savePluginConfiguration({
        requestId: crypto.randomUUID(),
        pluginId: snapshot.pluginId,
        expectedRevision: snapshot.revision,
        values: prepared.values,
        secretValues: Object.fromEntries(Object.entries(secretValues).filter((entry) => entry[1].length > 0)),
        clearSecrets: [...clearedSecrets],
      });
      if (!mounted.current) return;
      if (result.status === "saved") {
        resetFromSnapshot(result.snapshot);
        setNotice("配置已保存，新会话将使用新配置");
      } else if (result.status === "conflict") {
        setSnapshot(result.current);
        setError("插件配置已在其他窗口中变化，请检查当前输入后重试");
      } else {
        setSnapshot(result.snapshot);
        setFieldErrors(errorMap(result.errors));
      }
    } catch (reason) {
      if (mounted.current) setError(configurationErrorMessage(reason));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [clearedSecrets, dirty, resetFromSnapshot, saving, secretValues, snapshot, values]);

  return {
    snapshot,
    values,
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
    save,
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
