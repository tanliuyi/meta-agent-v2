/// <reference types="vite/client" />

import type { BrowserInternalApi } from "../../shared/browser-internal-contracts.ts";
import type { DesktopApi } from "../../shared/desktop-api.ts";

declare global {
  interface Window {
    desktop: DesktopApi;
    browserInternal: BrowserInternalApi;
  }
}
