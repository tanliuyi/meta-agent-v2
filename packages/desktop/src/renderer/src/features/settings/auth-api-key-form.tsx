import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.mjs";
import { useMemo, useState } from "react";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";
import { AuthEnvEditor } from "./auth-env-editor.tsx";
import { validateAuthKeySyntax } from "./auth-settings-model.ts";

interface AuthApiKeyFormProps {
  provider: AuthProviderDraft;
  knownProviders: AuthProviderInfo[];
  onChange(next: AuthProviderDraft): void;
}

/** API key credential editing form. */
export function AuthApiKeyForm({ provider, knownProviders, onChange }: AuthApiKeyFormProps) {
  const [showKey, setShowKey] = useState(false);
  const knownProvider = knownProviders.find((kp) => kp.id === provider.key);
  const keySyntaxError = useMemo(
    () => (provider.apiKey?.key ? validateAuthKeySyntax(provider.apiKey.key) : undefined),
    [provider.apiKey?.key],
  );

  if (!provider.apiKey) return null;

  return (
    <div className="auth-api-key-form">
      <div className="auth-field">
        <label className="auth-field-label">API Key</label>
        <div className="auth-key-input-group">
          <Input
            type={showKey ? "text" : "password"}
            value={provider.apiKey.key}
            placeholder="sk-ant-..., $ENV_VAR, !command"
            onChange={(event) => {
              onChange({
                ...provider,
                apiKey: { ...provider.apiKey!, key: event.target.value },
              });
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

      <AuthEnvEditor
        env={provider.apiKey.env ?? []}
        onChange={(env) => {
          onChange({
            ...provider,
            apiKey: { ...provider.apiKey!, env },
          });
        }}
      />

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
