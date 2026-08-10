import GlobeIcon from "lucide-react/dist/esm/icons/globe.mjs";
import PlusIcon from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2.mjs";
import XIcon from "lucide-react/dist/esm/icons/x.mjs";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type {
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  BrowserPermissionKind,
  BrowserPermissionValue,
  BrowserSitePermission,
} from "../../../../../../shared/browser-data-contracts.ts";
import { BROWSER_PERMISSION_KINDS } from "../../../../../../shared/browser-data-contracts.ts";
import { BrowserInternalEmpty } from "./browser-internal-empty.tsx";
import { BrowserInternalPageHeader } from "./browser-internal-header.tsx";

/** 网站设置：站点级权限覆盖（摄像头/麦克风/通知/位置/剪贴板/全屏）。 */

const PERMISSION_LABELS: Record<BrowserPermissionKind, string> = {
  camera: "摄像头",
  microphone: "麦克风",
  notifications: "通知",
  geolocation: "位置信息",
  clipboard: "剪贴板",
  fullscreen: "全屏",
};

const PERMISSION_DESCRIPTIONS: Record<BrowserPermissionKind, string> = {
  camera: "控制网站能否使用你的摄像头",
  microphone: "控制网站能否使用你的麦克风",
  notifications: "控制网站能否向你发送通知",
  geolocation: "控制网站能否获取你的位置",
  clipboard: "控制网站能否读取你的剪贴板",
  fullscreen: "控制网站能否进入全屏模式",
};

const PERMISSION_OPTIONS: ReadonlyArray<{ value: BrowserPermissionValue; label: string }> = [
  { value: "allow", label: "允许" },
  { value: "deny", label: "拒绝" },
];

interface SitePermissionDraft {
  site: string;
  kind: BrowserPermissionKind;
  value: BrowserPermissionValue;
}

export function BrowserSiteSettingsPage({
  snapshot,
  onSave,
  onDelete,
}: {
  snapshot: BrowserDataSnapshot | null;
  onSave: (input: {
    site: string;
    kind: BrowserPermissionKind;
    value: BrowserPermissionValue;
  }) => Promise<BrowserDataMutateResult>;
  onDelete: (id: string) => Promise<BrowserDataMutateResult>;
}): ReactNode {
  const [draft, setDraft] = useState<SitePermissionDraft | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const byKind = useMemo(() => {
    const map = new Map<BrowserPermissionKind, BrowserSitePermission[]>();
    for (const entry of snapshot?.sitePermissions ?? []) {
      const list = map.get(entry.kind);
      if (list) list.push(entry);
      else map.set(entry.kind, [entry]);
    }
    return map;
  }, [snapshot]);

  const submit = async (): Promise<void> => {
    if (!draft) return;
    const site = draft.site
      .trim()
      .replace(/^https?:\/\//i, "")
      .toLowerCase();
    if (site.length === 0 || site.includes("/")) {
      setFormError("请输入站点域名（如 example.com 或 example.com:8080）");
      return;
    }
    setSaving(true);
    const result = await onSave({ site, kind: draft.kind, value: draft.value });
    setSaving(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setDraft(null);
  };

  return (
    <div className="browser-internal-page">
      <BrowserInternalPageHeader
        title="网站设置"
        actions={
          <button
            type="button"
            className="browser-internal-button browser-internal-button-primary"
            onClick={() => {
              setFormError("");
              setDraft({ site: "", kind: "camera", value: "allow" });
            }}
          >
            <PlusIcon size={13} aria-hidden="true" />
            添加站点设置
          </button>
        }
      />
      {!snapshot ? (
        <BrowserInternalEmpty text="正在加载…" />
      ) : snapshot.sitePermissions.length === 0 ? (
        <BrowserInternalEmpty text="尚未添加网站设置" />
      ) : (
        <div className="browser-internal-list">
          {BROWSER_PERMISSION_KINDS.map((kind) => {
            const entries = byKind.get(kind) ?? [];
            if (entries.length === 0) return null;
            return (
              <section key={kind} className="browser-site-permission-group">
                <h3 className="browser-site-permission-group-title">
                  <span>{PERMISSION_LABELS[kind]}</span>
                  <span className="browser-site-permission-group-desc">{PERMISSION_DESCRIPTIONS[kind]}</span>
                </h3>
                <ul className="browser-internal-list">
                  {entries.map((entry) => (
                    <li key={entry.id} className="browser-site-permission-row">
                      <span className="browser-site-permission-icon" aria-hidden="true">
                        <GlobeIcon size={15} />
                      </span>
                      <span className="browser-site-permission-site">{entry.site}</span>
                      <select
                        className="browser-internal-select"
                        aria-label={`${entry.site} ${PERMISSION_LABELS[kind]}权限`}
                        value={entry.value}
                        onChange={(event) =>
                          void onSave({
                            site: entry.site,
                            kind: entry.kind,
                            value: event.target.value as BrowserPermissionValue,
                          })
                        }
                      >
                        {PERMISSION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="browser-internal-button"
                        title="删除"
                        aria-label={`删除 ${entry.site} 的${PERMISSION_LABELS[kind]}设置`}
                        onClick={() => void onDelete(entry.id)}
                      >
                        <Trash2Icon size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {draft ? (
        <div className="browser-internal-modal-backdrop" role="presentation">
          <div className="browser-internal-modal" role="dialog" aria-modal="true" aria-label="添加网站设置">
            <div className="browser-internal-modal-heading">
              <h3>添加网站设置</h3>
              <button
                type="button"
                className="browser-internal-button"
                aria-label="关闭"
                onClick={() => setDraft(null)}
              >
                <XIcon size={14} aria-hidden="true" />
              </button>
            </div>
            <label className="browser-internal-field">
              <span>站点</span>
              <input
                type="text"
                value={draft.site}
                placeholder="example.com"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, site: event.target.value })}
              />
            </label>
            <label className="browser-internal-field">
              <span>权限类型</span>
              <select
                className="browser-internal-select"
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as BrowserPermissionKind })}
              >
                {BROWSER_PERMISSION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {PERMISSION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="browser-internal-field">
              <span>行为</span>
              <select
                className="browser-internal-select"
                value={draft.value}
                onChange={(event) => setDraft({ ...draft, value: event.target.value as BrowserPermissionValue })}
              >
                {PERMISSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {formError ? <div className="browser-internal-form-error">{formError}</div> : null}
            <div className="browser-internal-modal-actions">
              <button type="button" className="browser-internal-button" onClick={() => setDraft(null)}>
                取消
              </button>
              <button
                type="button"
                className="browser-internal-button browser-internal-button-primary"
                disabled={saving}
                onClick={() => void submit()}
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
