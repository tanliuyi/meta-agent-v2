import EyeIcon from "lucide-react/dist/esm/icons/eye.mjs";
import EyeOffIcon from "lucide-react/dist/esm/icons/eye-off.mjs";
import KeyRoundIcon from "lucide-react/dist/esm/icons/key-round.mjs";
import PencilIcon from "lucide-react/dist/esm/icons/pencil.mjs";
import PlusIcon from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2.mjs";
import XIcon from "lucide-react/dist/esm/icons/x.mjs";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type {
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  BrowserPasswordInput,
  SavedPassword,
} from "../../../../../../shared/browser-data-contracts.ts";
import { BrowserInternalEmpty } from "./browser-internal-empty.tsx";
import { formatInternalDateTime } from "./browser-internal-format.ts";
import { BrowserInternalPageHeader } from "./browser-internal-header.tsx";

/** 密码管理器：查看/添加/编辑/删除已保存的登录凭据（密文存于系统安全存储）。 */

interface PasswordEditorState {
  id: string | null;
  origin: string;
  username: string;
  password: string;
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

export function BrowserPasswordsPage({
  snapshot,
  onSave,
  onDelete,
}: {
  snapshot: BrowserDataSnapshot | null;
  onSave: (input: { passwordId: string | null; password: BrowserPasswordInput }) => Promise<BrowserDataMutateResult>;
  onDelete: (id: string) => Promise<BrowserDataMutateResult>;
}): ReactNode {
  const [editor, setEditor] = useState<PasswordEditorState | null>(null);
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const passwords = useMemo(
    () =>
      [...(snapshot?.passwords ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || a.origin.localeCompare(b.origin)),
    [snapshot],
  );

  const openNew = (): void => {
    setFormError("");
    setEditor({ id: null, origin: "", username: "", password: "" });
  };
  const openEdit = (entry: SavedPassword): void => {
    setFormError("");
    setVisibleId(null);
    setEditor({ id: entry.id, origin: entry.origin, username: entry.username, password: entry.password });
  };

  const submitEditor = async (): Promise<void> => {
    if (!editor) return;
    let origin = editor.origin.trim();
    if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      setFormError("网站地址无效，请输入完整地址（如 https://example.com）");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setFormError("仅支持 http/https 网站");
      return;
    }
    if (editor.username.trim().length === 0) {
      setFormError("请输入用户名");
      return;
    }
    if (editor.password.length === 0) {
      setFormError("请输入密码");
      return;
    }
    setSaving(true);
    const result = await onSave({
      passwordId: editor.id,
      password: {
        origin: parsed.origin,
        username: editor.username.trim(),
        password: editor.password,
      },
    });
    setSaving(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setEditor(null);
  };

  return (
    <div className="browser-internal-page">
      <BrowserInternalPageHeader
        title="密码管理器"
        actions={
          <button type="button" className="browser-internal-button browser-internal-button-primary" onClick={openNew}>
            <PlusIcon size={13} aria-hidden="true" />
            添加
          </button>
        }
      />
      {!snapshot ? (
        <BrowserInternalEmpty text="正在加载…" />
      ) : passwords.length === 0 ? (
        <BrowserInternalEmpty text="尚未保存任何密码" />
      ) : (
        <ul className="browser-internal-list">
          {passwords.map((entry) => (
            <li key={entry.id} className="browser-password-row">
              <span className="browser-password-icon" aria-hidden="true">
                <KeyRoundIcon size={16} />
              </span>
              <span className="browser-password-main">
                <span className="browser-password-site">{hostOfOrigin(entry.origin)}</span>
                <span className="browser-password-username">{entry.username}</span>
                <span className="browser-password-meta">更新于 {formatInternalDateTime(entry.updatedAt)}</span>
              </span>
              <span className="browser-password-value">{visibleId === entry.id ? entry.password : "••••••••••"}</span>
              <span className="browser-password-actions">
                <button
                  type="button"
                  className="browser-internal-button"
                  title={visibleId === entry.id ? "隐藏密码" : "显示密码"}
                  aria-label={visibleId === entry.id ? "隐藏密码" : "显示密码"}
                  onClick={() => setVisibleId(visibleId === entry.id ? null : entry.id)}
                >
                  {visibleId === entry.id ? (
                    <EyeOffIcon size={13} aria-hidden="true" />
                  ) : (
                    <EyeIcon size={13} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className="browser-internal-button"
                  title="编辑"
                  aria-label={`编辑 ${entry.username} 的密码`}
                  onClick={() => openEdit(entry)}
                >
                  <PencilIcon size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="browser-internal-button"
                  title="删除"
                  aria-label={`删除 ${entry.username} 的密码`}
                  onClick={() => void onDelete(entry.id)}
                >
                  <Trash2Icon size={13} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editor ? (
        <div className="browser-internal-modal-backdrop" role="presentation">
          <div className="browser-internal-modal" role="dialog" aria-modal="true" aria-label="编辑密码">
            <div className="browser-internal-modal-heading">
              <h3>{editor.id === null ? "添加密码" : "编辑密码"}</h3>
              <button
                type="button"
                className="browser-internal-button"
                aria-label="关闭"
                onClick={() => setEditor(null)}
              >
                <XIcon size={14} aria-hidden="true" />
              </button>
            </div>
            <label className="browser-internal-field">
              <span>网站</span>
              <input
                type="text"
                value={editor.origin}
                placeholder="https://example.com"
                spellCheck={false}
                onChange={(event) => setEditor({ ...editor, origin: event.target.value })}
              />
            </label>
            <label className="browser-internal-field">
              <span>用户名</span>
              <input
                type="text"
                value={editor.username}
                spellCheck={false}
                onChange={(event) => setEditor({ ...editor, username: event.target.value })}
              />
            </label>
            <label className="browser-internal-field">
              <span>密码</span>
              <input
                type="text"
                value={editor.password}
                spellCheck={false}
                onChange={(event) => setEditor({ ...editor, password: event.target.value })}
              />
            </label>
            {formError ? <div className="browser-internal-form-error">{formError}</div> : null}
            <div className="browser-internal-modal-actions">
              <button type="button" className="browser-internal-button" onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="browser-internal-button browser-internal-button-primary"
                disabled={saving}
                onClick={() => void submitEditor()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
