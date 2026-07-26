import { Select } from "@renderer/components/assistant-ui/select/select";
import { Input } from "@renderer/shared/ui/input";
import { useRef, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import type { ProviderConnectionDefaults } from "../../../../shared/providers-config-contracts.ts";
import { ModelsMapEditor } from "./models-map-editor.tsx";
import { createProviderDraft } from "./models-settings-model.ts";

interface ProviderConnectionFormProps {
  /** The models draft entry for this provider, or undefined if not yet configured. */
  provider?: ModelsProviderDraft;
  /** Provider key (used as default ID when creating a new draft). */
  entryKey: string;
  /** Read-only connection defaults registered by a built-in provider. */
  defaultConfig?: ProviderConnectionDefaults;
  /** Known API types for the Select dropdown. */
  knownApis: string[];
  onChange(p: ModelsProviderDraft): void;
}

/** Connection settings sub-form for the unified provider editor dialog. */
export function ProviderConnectionForm({
  provider,
  entryKey,
  defaultConfig,
  knownApis,
  onChange,
}: ProviderConnectionFormProps) {
  const draftRef = useRef<ModelsProviderDraft>(createInitialDraft(provider, entryKey));
  const [, rerenderDraft] = useState(0);
  const draft = draftRef.current;
  const effectiveConfig = { ...defaultConfig, ...draft.config };

  const emit = (next: ModelsProviderDraft, render = false): void => {
    draftRef.current = next;
    if (render) rerenderDraft((revision) => revision + 1);
    onChange(next);
  };
  const setConfigField = <Key extends keyof ModelsProviderDraft["config"]>(
    field: Key,
    value: ModelsProviderDraft["config"][Key],
    render = false,
  ) => {
    const current = draftRef.current;
    const nextConfig = { ...current.config, [field]: value };
    if (value === undefined || value === "") delete nextConfig[field];
    emit({ ...current, config: nextConfig }, render);
  };

  const apiValue = effectiveConfig.api ?? "";
  const [customApiSelected, setCustomApiSelected] = useState(() => !knownApis.includes(apiValue));
  const authHeaderValue = effectiveConfig.authHeader === undefined ? "" : String(effectiveConfig.authHeader);
  const setConnectionOverride = (
    field: "api" | "authHeader",
    value: ModelsProviderDraft["config"][typeof field],
  ): void => {
    const defaultValue = defaultConfig?.[field];
    setConfigField(field, value === defaultValue ? undefined : value, true);
  };
  const apiSuggestions =
    knownApis.length > 0
      ? [{ value: "custom", label: "自定义" }, ...knownApis.map((api) => ({ value: api, label: api }))]
      : [{ value: "custom", label: "自定义" }];

  return (
    <div className="providers-connection-form">
      <div className="providers-form-grid providers-connection-grid">
        <label>
          <span>Provider ID</span>
          <Input
            defaultValue={draft.key}
            onChange={(event) => emit({ ...draftRef.current, key: event.target.value })}
          />
        </label>
        <label>
          <span>显示名称</span>
          <Input
            defaultValue={effectiveConfig.name ?? ""}
            onChange={(e) => setConfigField("name", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>Base URL</span>
          <Input
            defaultValue={effectiveConfig.baseUrl ?? ""}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => setConfigField("baseUrl", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>API</span>
          <div className="providers-combo-row">
            <Input
              key={apiValue}
              defaultValue={apiValue}
              placeholder="自定义 API 类型"
              disabled={!customApiSelected}
              onChange={(e) => setConfigField("api", e.target.value || undefined)}
            />
            <Select
              className="providers-select"
              value={customApiSelected ? "custom" : apiValue}
              onValueChange={(nextValue) => {
                if (nextValue === "custom") {
                  setCustomApiSelected(true);
                  return;
                }
                setCustomApiSelected(false);
                const currentApi = draftRef.current.config.api ?? defaultConfig?.api ?? "";
                if (nextValue !== currentApi) setConnectionOverride("api", nextValue);
              }}
              options={apiSuggestions}
            />
          </div>
        </label>
        <label>
          <span>API Key (models.json)</span>
          <Input
            type="password"
            autoComplete="off"
            defaultValue={draft.config.apiKey ?? ""}
            placeholder="$ENV 或字面量"
            onChange={(e) => setConfigField("apiKey", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>OAuth (models.json)</span>
          <Select
            className="providers-select"
            value={draft.config.oauth ?? "unset"}
            onValueChange={(nextValue) => setConfigField("oauth", nextValue === "radius" ? "radius" : undefined, true)}
            options={[
              { value: "unset", label: "未设置" },
              { value: "radius", label: "radius" },
            ]}
          />
        </label>
        <label>
          <span>Auth Header</span>
          <Select
            className="providers-select"
            value={authHeaderValue}
            onValueChange={(nextValue) => {
              const currentAuthHeader = draftRef.current.config.authHeader ?? defaultConfig?.authHeader;
              if (nextValue === (currentAuthHeader === undefined ? "" : String(currentAuthHeader))) return;
              setConnectionOverride("authHeader", nextValue === "" ? undefined : nextValue === "true");
            }}
            options={[
              { value: "", label: "未设置" },
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
          />
        </label>
      </div>
      <ModelsMapEditor
        label="Provider headers"
        entries={draft.headers}
        onChange={(headers) => emit({ ...draftRef.current, headers })}
      />
    </div>
  );
}

function createInitialDraft(provider: ModelsProviderDraft | undefined, key: string): ModelsProviderDraft {
  const draft = provider ? structuredClone(provider) : createProviderDraft(key);
  return draft.key === "" ? { ...draft, key } : draft;
}
