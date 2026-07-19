import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useMemo, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";

interface ModelsProviderListProps {
  providers: ModelsProviderDraft[];
  metadata: ModelsConfigMetadata;
  selectedIndex?: number;
  onSelect(index: number): void;
  onAdd(key: string): void;
}

/** Searchable provider navigation with built-in and custom add modes. */
export function ModelsProviderList({ providers, metadata, selectedIndex, onSelect, onAdd }: ModelsProviderListProps) {
  const [query, setQuery] = useState("");
  const [newKey, setNewKey] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const indexedProviders = providers.map((provider, index) => ({ provider, index }));
    if (!normalized) return indexedProviders;
    return indexedProviders.filter(({ provider }) =>
      `${provider.key} ${provider.config.name ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [providers, query]);
  const availableBuiltIns = metadata.builtInProviders.filter(
    (provider) => !providers.some((current) => current.key === provider.id),
  );

  return (
    <aside className="models-provider-pane" aria-label="Provider 列表">
      <div className="models-provider-tools">
        <Input
          type="search"
          value={query}
          placeholder="搜索 Provider"
          aria-label="搜索 Provider"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="models-add-provider">
          <Input
            value={newKey}
            placeholder="Provider ID"
            aria-label="新 Provider ID"
            onChange={(event) => setNewKey(event.target.value)}
          />
          <Select
            className="models-select models-suggestion-select"
            value={availableBuiltIns.some((provider) => provider.id === newKey) ? newKey : "custom"}
            onValueChange={(nextValue) => {
              if (nextValue !== "custom") setNewKey(nextValue);
            }}
            options={[
              { value: "custom", label: "自定义 Provider" },
              ...availableBuiltIns.map((provider) => ({ value: provider.id, label: provider.displayName })),
            ]}
          />
          <Button
            size="icon"
            variant="outline"
            disabled={!newKey.trim()}
            title="添加 Provider"
            aria-label="添加 Provider"
            onClick={() => {
              onAdd(newKey.trim());
              setNewKey("");
            }}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="models-provider-list" role="listbox" aria-label="已配置 Provider">
        {filtered.map(({ provider, index }) => {
          const builtIn = metadata.builtInProviders.find((item) => item.id === provider.key);
          const modelCount = provider.models.length + provider.modelOverrides.length;
          return (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-active={index === selectedIndex || undefined}
              key={provider.origin ? `origin:${provider.origin.providerKey}` : `new:${index}`}
              onClick={() => onSelect(index)}
            >
              <span>{provider.config.name || builtIn?.displayName || provider.key}</span>
              <small>
                {provider.key} · {modelCount} 项
              </small>
            </button>
          );
        })}
        {filtered.length === 0 ? <p>没有匹配的 Provider</p> : null}
      </div>
    </aside>
  );
}
