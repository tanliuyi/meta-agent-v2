import PencilIcon from "lucide-react/dist/esm/icons/pencil.mjs";
import PlusIcon from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2.mjs";
import UsersIcon from "lucide-react/dist/esm/icons/users.mjs";
import XIcon from "lucide-react/dist/esm/icons/x.mjs";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type {
  BrowserContactInput,
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  ContactProfile,
} from "../../../../../../shared/browser-data-contracts.ts";
import { BrowserInternalEmpty } from "./browser-internal-empty.tsx";
import { BrowserInternalPageHeader } from "./browser-internal-header.tsx";

/** 联系信息：自动填充表单用（右键菜单“使用联系信息填充表单”）。 */

interface ContactEditorState {
  id: string | null;
  contact: BrowserContactInput;
}

const EMPTY_CONTACT: BrowserContactInput = {
  fullName: "",
  email: "",
  phone: "",
  company: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
};

const CONTACT_FIELDS: ReadonlyArray<{ key: keyof BrowserContactInput; label: string; placeholder: string }> = [
  { key: "fullName", label: "姓名", placeholder: "张三" },
  { key: "email", label: "电子邮箱", placeholder: "name@example.com" },
  { key: "phone", label: "电话", placeholder: "13800000000" },
  { key: "company", label: "公司", placeholder: "" },
  { key: "addressLine1", label: "地址（行 1）", placeholder: "" },
  { key: "addressLine2", label: "地址（行 2）", placeholder: "" },
  { key: "city", label: "城市", placeholder: "" },
  { key: "region", label: "省/州", placeholder: "" },
  { key: "postalCode", label: "邮政编码", placeholder: "" },
  { key: "country", label: "国家/地区", placeholder: "" },
];

export function BrowserContactsPage({
  snapshot,
  onSave,
  onDelete,
}: {
  snapshot: BrowserDataSnapshot | null;
  onSave: (input: { contactId: string | null; contact: BrowserContactInput }) => Promise<BrowserDataMutateResult>;
  onDelete: (id: string) => Promise<BrowserDataMutateResult>;
}): ReactNode {
  const [editor, setEditor] = useState<ContactEditorState | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const contacts = useMemo(
    () =>
      [...(snapshot?.contacts ?? [])].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.fullName.localeCompare(b.fullName, "zh-CN"),
      ),
    [snapshot],
  );

  const openNew = (): void => {
    setFormError("");
    setEditor({ id: null, contact: { ...EMPTY_CONTACT } });
  };
  const openEdit = (contact: ContactProfile): void => {
    setFormError("");
    setEditor({
      id: contact.id,
      contact: {
        fullName: contact.fullName,
        email: contact.email,
        phone: contact.phone,
        company: contact.company,
        addressLine1: contact.addressLine1,
        addressLine2: contact.addressLine2,
        city: contact.city,
        region: contact.region,
        postalCode: contact.postalCode,
        country: contact.country,
      },
    });
  };

  const submitEditor = async (): Promise<void> => {
    if (!editor) return;
    if (editor.contact.fullName.trim().length === 0) {
      setFormError("请输入姓名");
      return;
    }
    setSaving(true);
    const result = await onSave({
      contactId: editor.id,
      contact: {
        ...editor.contact,
        fullName: editor.contact.fullName.trim(),
        email: editor.contact.email.trim(),
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
        title="联系信息"
        actions={
          <button type="button" className="browser-internal-button browser-internal-button-primary" onClick={openNew}>
            <PlusIcon size={13} aria-hidden="true" />
            添加
          </button>
        }
      />
      {!snapshot ? (
        <BrowserInternalEmpty text="正在加载…" />
      ) : contacts.length === 0 ? (
        <BrowserInternalEmpty text="尚未添加联系信息" />
      ) : (
        <ul className="browser-internal-list">
          {contacts.map((contact) => {
            const details = [
              contact.email,
              contact.phone,
              contact.company,
              [contact.addressLine1, contact.city, contact.region, contact.country].filter(Boolean).join(" "),
            ].filter(Boolean);
            return (
              <li key={contact.id} className="browser-contact-row">
                <span className="browser-contact-icon" aria-hidden="true">
                  <UsersIcon size={16} />
                </span>
                <span className="browser-contact-main">
                  <span className="browser-contact-name">{contact.fullName}</span>
                  <span className="browser-contact-details">{details.join(" · ")}</span>
                </span>
                <span className="browser-contact-actions">
                  <button
                    type="button"
                    className="browser-internal-button"
                    title="编辑"
                    aria-label={`编辑 ${contact.fullName}`}
                    onClick={() => openEdit(contact)}
                  >
                    <PencilIcon size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="browser-internal-button"
                    title="删除"
                    aria-label={`删除 ${contact.fullName}`}
                    onClick={() => void onDelete(contact.id)}
                  >
                    <Trash2Icon size={13} aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editor ? (
        <div className="browser-internal-modal-backdrop" role="presentation">
          <div className="browser-internal-modal" role="dialog" aria-modal="true" aria-label="编辑联系信息">
            <div className="browser-internal-modal-heading">
              <h3>{editor.id === null ? "添加联系信息" : "编辑联系信息"}</h3>
              <button
                type="button"
                className="browser-internal-button"
                aria-label="关闭"
                onClick={() => setEditor(null)}
              >
                <XIcon size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="browser-internal-form-grid">
              {CONTACT_FIELDS.map((field) => (
                <label key={field.key} className="browser-internal-field">
                  <span>{field.label}</span>
                  <input
                    type="text"
                    value={editor.contact[field.key]}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    onChange={(event) =>
                      setEditor({ ...editor, contact: { ...editor.contact, [field.key]: event.target.value } })
                    }
                  />
                </label>
              ))}
            </div>
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
