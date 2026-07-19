import { WindowsHeader } from "@renderer/components/layout/windows-header";
import { useDesktopSelector } from "@renderer/state/desktop-context";
import { selectWindowTitle } from "@renderer/state/desktop-selectors";
import { useEffect } from "react";

/** 同步原生窗口标题，并把标题更新限制在 Windows header 子树。 */
export function DesktopWindowTitle() {
  const title = useDesktopSelector(selectWindowTitle);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return window.desktop.platform === "win32" ? <WindowsHeader title={title} /> : null;
}
