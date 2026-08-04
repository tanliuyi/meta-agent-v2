import { Input } from "@renderer/shared/ui/input";
import { useTerminal } from "@renderer/state/terminal";
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STEP,
} from "@renderer/state/terminal-preference";
import { useEffect, useState } from "react";

export const TERMINAL_FONT_SIZE_LABEL_ID = "terminal-font-size-label";

/** 自定义终端字号（px）：范围内即时生效，失焦或回车收敛到步进刻度。 */
export function TerminalFontSizeControl() {
  const { fontSize, setFontSize } = useTerminal();
  const [draft, setDraft] = useState(String(fontSize));

  useEffect(() => {
    setDraft(String(fontSize));
  }, [fontSize]);

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? clampTerminalFontSize(parsed) : fontSize;
    setDraft(String(next));
    if (next !== fontSize) setFontSize(next);
  };

  return (
    <div className="settings-font-size-control">
      <Input
        aria-labelledby={TERMINAL_FONT_SIZE_LABEL_ID}
        className="w-22"
        type="number"
        min={TERMINAL_FONT_SIZE_MIN}
        max={TERMINAL_FONT_SIZE_MAX}
        step={TERMINAL_FONT_SIZE_STEP}
        value={draft}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = Number.parseFloat(raw);
          if (Number.isFinite(parsed) && parsed >= TERMINAL_FONT_SIZE_MIN && parsed <= TERMINAL_FONT_SIZE_MAX) {
            const next = clampTerminalFontSize(parsed);
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
