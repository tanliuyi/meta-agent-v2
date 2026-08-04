import { Input } from "@renderer/shared/ui/input";
import { useFont } from "@renderer/state/font";
import { sanitizeUiFontFamily } from "@renderer/state/font-preference";
import { useEffect, useState } from "react";

export const FONT_FAMILY_LABEL_ID = "ui-font-family-label";

/** 编辑自定义 UI 字体族，失焦或回车提交，清空即回到默认字体。 */
export function FontFamilyControl() {
  const { fontFamily, setFontFamily } = useFont();
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
        aria-labelledby={FONT_FAMILY_LABEL_ID}
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
