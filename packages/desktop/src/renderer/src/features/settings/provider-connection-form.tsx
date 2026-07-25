import { Select } from "@renderer/components/assistant-ui/select/select";
import { Input } from "@renderer/shared/ui/input";
import { useState } from "react";
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
  const actual = provider ?? createPlaceholderDraft(entryKey);
  const draft = actual.key === "" ? { ...actual, key: entryKey } : actual;
  const effectiveConfig = { ...defaultConfig, ...draft.config };

  const setConfigField = <Key extends keyof ModelsProviderDraft["config"]>(
    field: Key,
    value: ModelsProviderDraft["config"][Key],
  ) => {
    const next = { ...draft.config, [field]: value };
    if (value === undefined || value === "") delete next[field];
    onChange({ ...draft, config: next });
  };

  const apiValue = effectiveConfig.api ?? "";
  const [customApiSelected, setCustomApiSelected] = useState(() => !knownApis.includes(apiValue));
  const authHeaderValue = effectiveConfig.authHeader === undefined ? "" : String(effectiveConfig.authHeader);
  const apiSuggestions =
    knownApis.length > 0
      ? [{ value: "custom", label: "自定义" }, ...knownApis.map((api) => ({ value: api, label: api }))]
      : [{ value: "custom", label: "自定义" }];

  return (
    <div className="providers-connection-form">
      <div className="providers-form-grid providers-connection-grid">
        <label>
          <span>Provider ID</span>
          <Input value={draft.key} onChange={(e) => onChange({ ...draft, key: e.target.value })} />
        </label>
        <label>
          <span>显示名称</span>
          <Input
            value={effectiveConfig.name ?? ""}
            onChange={(e) => setConfigField("name", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>Base URL</span>
          <Input
            value={effectiveConfig.baseUrl ?? ""}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => setConfigField("baseUrl", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>API</span>
          <div className="providers-combo-row">
            <Input
              value={apiValue}
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
                if (nextValue !== apiValue) setConfigField("api", nextValue);
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
            value={draft.config.apiKey ?? ""}
            placeholder="$ENV 或字面量"
            onChange={(e) => setConfigField("apiKey", e.target.value || undefined)}
          />
        </label>
        <label>
          <span>OAuth (models.json)</span>
          <Select
            className="providers-select"
            value={draft.config.oauth ?? "unset"}
            onValueChange={(nextValue) => setConfigField("oauth", nextValue === "radius" ? "radius" : undefined)}
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
              if (nextValue === authHeaderValue) return;
              if (nextValue === "") setConfigField("authHeader", undefined);
              else setConfigField("authHeader", nextValue === "true");
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
        onChange={(headers) => onChange({ ...draft, headers })}
      />
    </div>
  );
}

function createPlaceholderDraft(key: string): ModelsProviderDraft {
  return createProviderDraft(key);
}
