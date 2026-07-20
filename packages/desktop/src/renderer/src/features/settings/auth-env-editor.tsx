import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { AuthEnvEntry } from "../../../../shared/auth-config-contracts.ts";

interface AuthEnvEditorProps {
  env: AuthEnvEntry[];
  onChange(env: AuthEnvEntry[]): void;
}

const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/i;

/** Key-value table editor for provider-scoped environment variable overrides. */
export function AuthEnvEditor({ env, onChange }: AuthEnvEditorProps) {
  const addEntry = () => {
    onChange([...env, { key: "", value: "" }]);
  };

  const removeEntry = (index: number) => {
    const next = env.filter((_, i) => i !== index);
    onChange(next);
  };

  const updateKey = (index: number, key: string) => {
    const next = env.map((entry, i) => (i === index ? { ...entry, key } : entry));
    onChange(next);
  };

  const updateValue = (index: number, value: string) => {
    const next = env.map((entry, i) => (i === index ? { ...entry, value } : entry));
    onChange(next);
  };

  return (
    <div className="auth-env-editor">
      <label className="auth-field-label">Provider 环境变量覆盖</label>
      {env.length > 0 && (
        <table className="auth-env-table">
          <thead>
            <tr>
              <th>键</th>
              <th>值</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {env.map((entry, index) => (
              <tr key={`env-row-${index}`}>
                <td>
                  <Input
                    value={entry.key}
                    placeholder="CLOUDFLARE_ACCOUNT_ID"
                    aria-label={`环境变量键 ${index + 1}`}
                    className={entry.key && !VALID_ENV_KEY.test(entry.key) ? "auth-input-error" : ""}
                    onChange={(event) => updateKey(index, event.target.value)}
                  />
                </td>
                <td>
                  <Input
                    value={entry.value}
                    placeholder="值"
                    aria-label={`环境变量值 ${index + 1}`}
                    onChange={(event) => updateValue(index, event.target.value)}
                  />
                </td>
                <td>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除环境变量 ${index + 1}`}
                    onClick={() => removeEntry(index)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {env.length === 0 && <p className="auth-field-hint">尚未添加环境变量覆盖。运行时将使用进程环境变量。</p>}
      <Button variant="outline" size="sm" onClick={addEntry}>
        <Plus />
        添加环境变量
      </Button>
    </div>
  );
}
