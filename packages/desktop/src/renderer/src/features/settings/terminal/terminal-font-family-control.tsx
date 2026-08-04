import { Input } from "@renderer/shared/ui/input";
import { sanitizeUiFontFamily } from "@renderer/state/font-preference";
import { useTerminal } from "@renderer/state/terminal";
import { useEffect, useState } from "react";

export const TERMINAL_FONT_FAMILY_LABEL_ID = "terminal-font-family-label";

/** 编辑自定义终端字体族，失焦或回车提交，清空即回到默认字体。 */
export function TerminalFontFamilyControl() {
  const { fontFamily, setFontFamily } = useTerminal();
  const [draft, setDraft] = useState(fontFamily);

  useEffect(() => {
    setDraft(fontFamily);
  }, [fontFamily]);

  const commit = () => {
    const sanitized = sanitizeUiFontFamily(draft);
    setDraft(sanitized);
    if (sanitized !== fontFamily) setFontFamily(sanitized);
  };

  return (
    <div className="settings-font-family-control">
      <Input
        aria-labelledby={TERMINAL_FONT_FAMILY_LABEL_ID}
        value={draft}
        placeholder="系统默认字体"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setDraft(fontFamily);
        }}
      />
    </div>
  );
}
