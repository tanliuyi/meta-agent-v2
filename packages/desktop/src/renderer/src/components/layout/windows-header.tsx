import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useState } from "react";

/** 无边框 BrowserWindow 的 Windows 标题栏。 */
export function WindowsHeader() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.desktop.windowControls.onMaximizedChanged(setMaximized), []);

  return (
    <header className="windows-header">
      <div className="windows-header-title">
        <span className="windows-header-mark" aria-hidden="true">
          Pi
        </span>
      </div>
      <div className="windows-header-controls" aria-label="窗口控制">
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          onClick={() => window.desktop.windowControls.minimize()}
        >
          <Minus size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => window.desktop.windowControls.toggleMaximize()}
        >
          {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
        </button>
        <button
          type="button"
          className="windows-header-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => window.desktop.windowControls.close()}
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
