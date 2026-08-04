import { Input } from "@renderer/shared/ui/input";
import { useToast } from "@renderer/shared/ui/use-toast";
import { useEffect, useState } from "react";
import type {
  SaveSettingsConfigInput,
  SettingsConfigSnapshot,
} from "../../../../../shared/settings-config-contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";

export const TERMINAL_SHELL_LABEL_ID = "terminal-shell-label";

/** 清洗 Shell 输入：空白视为清除配置（回退默认），否则保留 trim 后的绝对路径。 */
export function normalizeTerminalShellPath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 与当前配置相比无变化时返回 null，否则构造带当前 revision 的保存输入。 */
export function terminalShellSaveInput(config: SettingsConfigSnapshot, draft: string): SaveSettingsConfigInput | null {
  const next = normalizeTerminalShellPath(draft);
  if (next === (config.settings.terminalShellPath ?? null)) return null;
  return { expectedRevision: config.revision, settings: { ...config.settings, terminalShellPath: next } };
}

/** 终端 Shell 路径：回车或失焦保存到 desktop settings.json，清空恢复默认解析。 */
export function TerminalShellControl() {
  const toast = useToast();
  const [config, setConfig] = useState<SettingsConfigSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.desktop.settings
      .getConfig()
      .then((snapshot) => {
        if (disposed) return;
        setConfig(snapshot);
        setDraft(snapshot.settings.terminalShellPath ?? "");
      })
      .catch(() => {
        // 读取失败保持空输入，保存时再提示。
      });
    return () => {
      disposed = true;
    };
  }, []);

  const commit = async () => {
    if (!config || saving) return;
    const input = terminalShellSaveInput(config, draft);
    if (!input) {
      setDraft(config.settings.terminalShellPath ?? "");
      return;
    }
    const next = input.settings.terminalShellPath;
    setSaving(true);
    try {
      const result = await window.desktop.settings.saveConfig(input);
      const snapshot = result.status === "saved" ? result.snapshot : result.current;
      setConfig(snapshot);
      setDraft(snapshot.settings.terminalShellPath ?? "");
      if (result.status === "saved") {
        toast.notify({
          title: "已保存",
          message: next ? `终端将使用 ${next}` : "终端将使用项目设置或系统默认 Shell",
          tone: "success",
        });
      } else {
        toast.notify({
          title: "保存冲突",
          message: "设置已在其他窗口修改，已加载最新配置",
          tone: "warning",
        });
      }
    } catch (saveError) {
      toast.notify({ title: "保存失败", message: errorMessage(saveError), tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-font-family-control">
      <Input
        aria-labelledby={TERMINAL_SHELL_LABEL_ID}
        value={draft}
        placeholder="留空使用默认 Shell"
        spellCheck={false}
        disabled={!config || saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          else if (event.key === "Escape") setDraft(config?.settings.terminalShellPath ?? "");
        }}
      />
    </div>
  );
}
