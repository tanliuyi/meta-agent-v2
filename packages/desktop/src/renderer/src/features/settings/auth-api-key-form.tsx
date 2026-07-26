import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.mjs";
import { useRef, useState } from "react";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";
import { validateAuthKeySyntax } from "./auth-settings-model.ts";

interface AuthApiKeyFormProps {
  provider: AuthProviderDraft;
  knownProviders: AuthProviderInfo[];
  onChange(next: AuthProviderDraft): void;
}

/** API key credential editing form. */
export function AuthApiKeyForm({ provider, knownProviders, onChange }: AuthApiKeyFormProps) {
  const providerRef = useRef(structuredClone(provider));
  const [showKey, setShowKey] = useState(false);
  const [keySyntaxError, setKeySyntaxError] = useState(() =>
    provider.apiKey?.key ? validateAuthKeySyntax(provider.apiKey.key) : undefined,
  );
  const knownProvider = knownProviders.find((known) => known.id === providerRef.current.key);

  if (!providerRef.current.apiKey) return null;

  return (
    <div className="auth-api-key-form">
      <div className="auth-field">
        <label className="auth-field-label">API Key</label>
        <div className="auth-key-input-group">
          <Input
            type={showKey ? "text" : "password"}
            defaultValue={providerRef.current.apiKey.key}
            placeholder="sk-ant-..., $ENV_VAR, !command"
            onChange={(event) => {
              const current = providerRef.current;
              const next = {
                ...current,
                apiKey: { ...current.apiKey!, key: event.target.value },
              };
              providerRef.current = next;
              setKeySyntaxError(event.target.value ? validateAuthKeySyntax(event.target.value) : undefined);
              onChange(next);
            }}
            className={keySyntaxError ? "auth-input-error" : ""}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={showKey ? "隐藏" : "显示"}
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <p className="auth-field-hint">支持字面量、$ENV 变量、!command 命令</p>
        {keySyntaxError && (
          <p className="auth-field-error" role="alert">
            {keySyntaxError}
          </p>
        )}
      </div>

      {knownProvider && knownProvider.envKeys.length > 0 && (
        <div className="auth-known-env-info">
          <p className="auth-field-label">关联环境变量</p>
          <code className="auth-env-keys">{knownProvider.envKeys.join(", ")}</code>
          <p className="auth-field-hint">当前 shell 中可用时自动注入</p>
        </div>
      )}
    </div>
  );
}
