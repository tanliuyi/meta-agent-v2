import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWebAccess from "pi-web-access/index.ts";
import { createDesktopApi } from "./desktop-api.ts";

export default function piWebAccessDesktop(pi: ExtensionAPI): void {
  piWebAccess(createDesktopApi(pi));
}
