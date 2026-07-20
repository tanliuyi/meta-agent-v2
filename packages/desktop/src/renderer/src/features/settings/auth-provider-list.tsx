import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useMemo, useState } from "react";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";

interface AuthProviderListProps {
  providers: AuthProviderDraft[];
  knownProviders: AuthProviderInfo[];
  selectedKey?: string;
  onSelect(key: string): void;
  onAdd(key: string): void;
}

function credentialTypeLabel(provider: AuthProviderDraft): { label: string; className: string } {
  if (provider.oauth) {
    return {
      label: provider.oauth.expired ? "OAuth (已过期)" : "OAuth",
      className: provider.oauth.expired
        ? "auth-type-badge auth-type-badge--oauth-expired"
        : "auth-type-badge auth-type-badge--oauth",
    };
  }
  if (provider.apiKey && provider.apiKey.key) {
    return { label: "API Key", className: "auth-type-badge auth-type-badge--apikey" };
  }
  return { label: "未配置", className: "auth-type-badge auth-type-badge--unconfigured" };
}

function maskApiKey(key: string): string {
  if (key.startsWith("$") || key.startsWith("!")) return key;
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function sourceLabel(provider: AuthProviderDraft, knownProviders: AuthProviderInfo[]): string | undefined {
  if (provider.apiKey && provider.apiKey.key) return "auth.json";
  // Check if this provider is known from built-in list
  const known = knownProviders.find((kp) => kp.id === provider.key);
  if (known) {
    // OAuth is managed by Pi TUI /login
    if (provider.oauth) return "OAuth";
  }
  return undefined;
}

/** Left-side provider list for the auth settings page. */
export function AuthProviderList({ providers, knownProviders, selectedKey, onSelect, onAdd }: AuthProviderListProps) {
  const [query, setQuery] = useState("");
  const [newKey, setNewKey] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const indexedProviders = providers.map((provider, index) => ({ provider, index }));
    if (!normalized) return indexedProviders;
    return indexedProviders.filter(({ provider }) =>
      `${provider.key} ${getDisplayName(provider.key, knownProviders)}`.toLowerCase().includes(normalized),
    );
  }, [providers, query, knownProviders]);
  const availableBuiltIns = knownProviders.filter((kp) => !providers.some((current) => current.key === kp.id));

  return (
    <aside className="auth-provider-pane" aria-label="Provider 凭据列表">
      <div className="auth-provider-tools">
        <Input
          type="search"
          value={query}
          placeholder="搜索 Provider"
          aria-label="搜索 Provider"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="auth-add-provider">
          <Input
            value={newKey}
            placeholder="Provider ID"
            aria-label="新 Provider ID"
            onChange={(event) => setNewKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newKey.trim()) {
                onAdd(newKey.trim());
                setNewKey("");
              }
            }}
          />
          {availableBuiltIns.length > 0 && (
            <Select
              value={newKey}
              placeholder="内置"
              onValueChange={(nextValue) => {
                onAdd(nextValue);
              }}
              options={availableBuiltIns.map((kp) => ({ value: kp.id, label: kp.displayName }))}
            />
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label="添加"
            disabled={!newKey.trim()}
            onClick={() => {
              if (newKey.trim()) {
                onAdd(newKey.trim());
                setNewKey("");
              }
            }}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="auth-provider-list" role="listbox" aria-label="Provider 列表">
        {filtered.map(({ provider }) => {
          const typeInfo = credentialTypeLabel(provider);
          const source = sourceLabel(provider, knownProviders);
          const displayName = getDisplayName(provider.key, knownProviders);
          return (
            <button
              key={provider.key}
              role="option"
              aria-selected={provider.key === selectedKey}
              data-active={provider.key === selectedKey || undefined}
              onClick={() => onSelect(provider.key)}
            >
              <span className="auth-provider-row-name">{displayName || provider.key}</span>
              <span className="auth-provider-row-key">{provider.key}</span>
              <span className="auth-provider-row-meta">
                <span className={typeInfo.className}>{typeInfo.label}</span>
                {source ? <span className="auth-source-badge">{source}</span> : null}
                {provider.apiKey?.key ? (
                  <span className="auth-provider-row-preview">{maskApiKey(provider.apiKey.key)}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="auth-empty-list">
            <p>{query ? "无匹配 provider" : "尚未添加凭据"}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function getDisplayName(key: string, knownProviders: AuthProviderInfo[]): string | undefined {
  return knownProviders.find((kp) => kp.id === key)?.displayName;
}
