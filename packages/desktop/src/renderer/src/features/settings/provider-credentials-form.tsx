import { Button } from "@renderer/shared/ui/button";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";
import { AuthApiKeyForm } from "./auth-api-key-form.tsx";

interface ProviderCredentialsFormProps {
  provider?: AuthProviderDraft;
  knownProvider?: AuthProviderInfo;
  entryKey: string;
  oauthDisabled: boolean;
  onChange(p: AuthProviderDraft): void;
  onDelete(): void;
  onOauthLogin(): void;
}

/** Credentials sub-form for the unified provider editor dialog. */
export function ProviderCredentialsForm({
  provider,
  knownProvider,
  entryKey,
  oauthDisabled,
  onChange,
  onDelete,
  onOauthLogin,
}: ProviderCredentialsFormProps) {
  const oauthButton = knownProvider?.oauth ? (
    <div>
      <Button variant="outline" disabled={oauthDisabled} onClick={onOauthLogin}>
        {provider?.oauth ? "重新登录 OAuth" : "使用 OAuth 登录"}
      </Button>
      {oauthDisabled ? <p className="providers-editor-hint">请先保存或放弃当前修改。</p> : null}
    </div>
  ) : null;

  if (provider?.oauth) {
    return (
      <div className="providers-form-grid">
        <p>OAuth 已配置</p>
        <p>Provider: {provider.oauth.providerName}</p>
        <p>过期: {provider.oauth.expired ? "已过期" : provider.oauth.expires}</p>
        {oauthButton}
        <div className="providers-editor-delete-cred">
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 />
            删除凭据
          </Button>
        </div>
      </div>
    );
  }

  if (provider?.apiKey) {
    return (
      <div className="providers-form-grid">
        <AuthApiKeyForm
          provider={provider}
          knownProviders={
            knownProvider
              ? [
                  {
                    id: knownProvider.id,
                    displayName: knownProvider.displayName,
                    envKeys: knownProvider.envKeys,
                  },
                ]
              : []
          }
          onChange={onChange}
        />
        {oauthButton}
        <div className="providers-editor-delete-cred">
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 />
            删除凭据
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="providers-form-grid">
      <p className="providers-editor-empty">该 Provider 没有本地凭据配置。</p>
      {knownProvider && knownProvider.envKeys.length > 0 ? (
        <p className="providers-editor-hint">环境变量: {knownProvider.envKeys.join(", ")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            onChange({
              key: entryKey,
              apiKey: { key: "", env: [] },
            })
          }
        >
          添加 API Key
        </Button>
        {oauthButton}
      </div>
    </div>
  );
}
