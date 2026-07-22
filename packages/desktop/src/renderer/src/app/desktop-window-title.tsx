import { WindowsHeader } from "@renderer/components/layout/windows-header";

/** Renders the custom Windows frame controls; the product title remains static. */
export function DesktopWindowTitle() {
  return window.desktop.platform === "win32" ? <WindowsHeader /> : null;
}
