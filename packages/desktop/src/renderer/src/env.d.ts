/// <reference types="vite/client" />

import type { DesktopApi } from "../../shared/desktop-api.ts";

declare global {
	interface Window {
		desktop: DesktopApi;
	}
}
