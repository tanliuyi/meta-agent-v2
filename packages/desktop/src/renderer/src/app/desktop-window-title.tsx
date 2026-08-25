import { DesktopHeader } from "@renderer/components/layout/desktop-header";

/** Renders the shared desktop title bar on platforms with custom title content. */
export function DesktopWindowTitle() {
  return window.desktop.platform === "linux" ? null : <DesktopHeader />;
}
