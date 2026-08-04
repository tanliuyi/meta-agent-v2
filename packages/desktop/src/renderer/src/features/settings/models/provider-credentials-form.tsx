import { Button } from "@renderer/shared/ui/button";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { useRef, useState } from "react";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../../shared/auth-config-contracts.ts";
import { AuthApiKeyForm } from "../auth/auth-api-key-form.tsx";

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
  const providerRef = useRef(provider ? structuredClone(provider) : undefined);
  const [, rerenderProvider] = useState(0);
  const current = providerRef.current;

  const updateProvider = (next: AuthProviderDraft | undefined, render = false): void => {
    providerRef.current = next;
    if (render) rerenderProvider((revision) => revision + 1);
    if (next) onChange(next);
    else onDelete();
  };

  const oauthButton = knownProvider?.oauth ? (
    <div>
      <Button variant="outline" disabled={oauthDisabled} onClick={onOauthLogin}>
        {current?.oauth ? "重新登录 OAuth" : "使用 OAuth 登录"}
      </Button>
      {oauthDisabled ? <p className="providers-editor-hint">请先保存或放弃当前修改。</p> : null}
    </div>
  ) : null;

  if (current?.oauth) {
    const expired = current.oauth.expired;
    return (
      <div className="providers-form-grid">
        <div className="providers-cred-card" data-tone={expired ? "warning" : "success"}>
          {expired ? <TriangleAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          <div className="providers-cred-card-body">
            <strong>{expired ? "OAuth 凭据已过期" : "OAuth 已配置"}</strong>
            <span>Provider：{current.oauth.providerName}</span>
            <span>{expired ? "请重新登录以刷新凭据。" : `过期时间：${current.oauth.expires}`}</span>
          </div>
        </div>
        {oauthButton}
        <div className="providers-editor-delete-cred">
          <Button variant="destructive" size="sm" onClick={() => updateProvider(undefined, true)}>
            <Trash2 />
            删除凭据
          </Button>
        </div>
      </div>
    );
  }

  if (current?.apiKey) {
    return (
      <div className="providers-form-grid">
        <AuthApiKeyForm
          provider={current}
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
          onChange={(next) => updateProvider(next)}
        />
        {oauthButton}
        <div className="providers-editor-delete-cred">
          <Button variant="destructive" size="sm" onClick={() => updateProvider(undefined, true)}>
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
            updateProvider(
              {
                key: entryKey,
                apiKey: { key: "", env: [] },
              },
              true,
            )
          }
        >
          添加 API Key
        </Button>
        {oauthButton}
      </div>
    </div>
  );
}
