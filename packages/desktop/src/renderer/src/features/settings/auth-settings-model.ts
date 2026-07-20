import type { AuthConfigDiagnostic, AuthProviderDraft } from "../../../../shared/auth-config-contracts.ts";

export function cloneAuthProviders(providers: AuthProviderDraft[]): AuthProviderDraft[] {
  return structuredClone(providers);
}

export function authDraftsEqual(left: AuthProviderDraft[], right: AuthProviderDraft[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createAuthProviderDraft(key: string): AuthProviderDraft {
  return {
    key,
    apiKey: {
      key: "",
      env: [],
    },
  };
}

export function validateAuthKeySyntax(key: string): string | undefined {
  if (key.length === 0) return undefined;
  if (key.startsWith("!")) {
    const command = key.slice(1);
    if (!command.trim() || command.startsWith("!")) return "!command 格式无效：命令不能为空或以 ! 开头";
    return undefined;
  }
  for (let index = 0; index < key.length; index += 1) {
    if (key[index] !== "$") continue;
    const next = key[index + 1];
    if (next === "$" || next === "!") {
      index += 1;
      continue;
    }
    if (next === "{") {
      const close = key.indexOf("}", index + 2);
      if (close < 0) return "环境变量模板括号不匹配";
      const name = key.slice(index + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "环境变量名格式无效";
      index = close;
      continue;
    }
    if (next && /^[A-Za-z_]$/.test(next)) {
      index += 1;
      while (index + 1 < key.length && /^[A-Za-z0-9_]$/.test(key[index + 1]!)) index += 1;
      continue;
    }
    return `环境变量引用格式无效：使用 $ENV、\${ENV} 或 $$/$! 转义`;
  }
  return undefined;
}

export function validateAuthDraft(providers: AuthProviderDraft[]): AuthConfigDiagnostic[] {
  const diagnostics: AuthConfigDiagnostic[] = [];
  const providerKeys = new Set<string>();

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const path = [provider.key] as const;

    if (!provider.key.trim()) {
      diagnostics.push(diagnostic(path, "Provider key 不能为空。"));
    } else if (providerKeys.has(provider.key)) {
      diagnostics.push(diagnostic(path, "Provider key 必须唯一。"));
    }
    providerKeys.add(provider.key);

    if (provider.apiKey) {
      const keySyntaxError = validateAuthKeySyntax(provider.apiKey.key);
      if (keySyntaxError) {
        diagnostics.push(diagnostic([...path, "key"], keySyntaxError));
      }
      // env key validation
      if (provider.apiKey.env) {
        const envKeys = new Set<string>();
        for (const entry of provider.apiKey.env) {
          if (!entry.key.trim()) {
            diagnostics.push(diagnostic([...path, "env", entry.key || ""], "环境变量名不能为空。"));
          } else if (envKeys.has(entry.key)) {
            diagnostics.push(diagnostic([...path, "env", entry.key], "环境变量名必须唯一。"));
          }
          envKeys.add(entry.key);
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(entry.key)) {
            diagnostics.push(diagnostic([...path, "env", entry.key], `环境变量名 "${entry.key}" 格式无效。`));
          }
        }
      }
    }
  }

  return diagnostics;
}

function diagnostic(path: readonly (string | number)[], message: string): AuthConfigDiagnostic {
  return { severity: "error", code: "renderer.invalid", path, message };
}
