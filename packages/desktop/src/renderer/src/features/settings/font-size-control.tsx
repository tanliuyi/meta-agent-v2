import { Input } from "@renderer/shared/ui/input";
import { useFont } from "@renderer/state/font";
import {
  clampUiFontSize,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_STEP,
} from "@renderer/state/font-preference";
import { useEffect, useState } from "react";

export const FONT_SIZE_LABEL_ID = "ui-font-size-label";

/** 自定义 UI 基准字号（px）：范围内即时生效，失焦或回车收敛到步进刻度。 */
export function FontSizeControl() {
  const { fontSize, setFontSize } = useFont();
  const [draft, setDraft] = useState(String(fontSize));

  useEffect(() => {
    setDraft(String(fontSize));
  }, [fontSize]);

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? clampUiFontSize(parsed) : fontSize;
    setDraft(String(next));
    if (next !== fontSize) setFontSize(next);
  };

  return (
    <div className="settings-font-size-control">
      <Input
        aria-labelledby={FONT_SIZE_LABEL_ID}
        className="w-22"
        type="number"
        min={UI_FONT_SIZE_MIN}
        max={UI_FONT_SIZE_MAX}
        step={UI_FONT_SIZE_STEP}
        value={draft}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = Number.parseFloat(raw);
          if (Number.isFinite(parsed) && parsed >= UI_FONT_SIZE_MIN && parsed <= UI_FONT_SIZE_MAX) {
            const next = clampUiFontSize(parsed);
            if (next !== fontSize) setFontSize(next);
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setDraft(String(fontSize));
        }}
      />
      <span aria-hidden="true">px</span>
    </div>
  );
}
