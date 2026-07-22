import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useMemo, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import { TooltipIconButton } from "../../components/assistant-ui/tooltip-icon-button.tsx";

interface ModelsProviderListProps {
  providers: ModelsProviderDraft[];
  metadata: ModelsConfigMetadata;
  selectedIndex?: number;
  onSelect(index: number): void;
  onAdd(): void;
}

/** Searchable provider navigation with built-in and custom add modes. */
export function ModelsProviderList({ providers, metadata, selectedIndex, onSelect, onAdd }: ModelsProviderListProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const indexedProviders = providers.map((provider, index) => ({
      provider,
      index,
    }));
    if (!normalized) return indexedProviders;
    return indexedProviders.filter(({ provider }) =>
      `${provider.key} ${provider.config.name ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [providers, query]);
  return (
    <aside className="models-provider-pane" aria-label="Provider 列表">
      <div className="models-provider-tools flex w-full">
        <Input
          type="search"
          value={query}
          placeholder="搜索 Provider"
          aria-label="搜索 Provider"
          onChange={(event) => setQuery(event.target.value)}
        />
        <TooltipIconButton
          variant="outline"
          className="flex-shrink-0 size-[30px]"
          aria-label="添加 Provider"
          tooltip={"添加 Provider"}
          onClick={() => onAdd()}
        >
          <Plus />
        </TooltipIconButton>
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
