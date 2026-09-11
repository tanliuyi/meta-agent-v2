import type { DesktopApi } from "../../../shared/desktop-api.ts";

export type SessionCommandGateway = Pick<
  DesktopApi["sessions"],
  "prompt" | "edit" | "reload" | "reloadResources" | "cancel" | "clearQueue"
>;

export interface SessionTransportGateway extends Pick<DesktopApi["sessions"], "attach" | "flush" | "detach"> {
  getWorkbench: DesktopApi["workbench"]["get"];
}

/** Electron preload adapter. Keep window.desktop access at the renderer composition boundary. */
export function createDesktopSessionCommandGateway(api: DesktopApi = window.desktop): SessionCommandGateway {
  return api.sessions;
}

/** Electron preload adapter for the window-scoped attachment transport. */
export function createDesktopSessionTransportGateway(api: DesktopApi = window.desktop): SessionTransportGateway {
  return {
    attach: api.sessions.attach,
    flush: api.sessions.flush,
    detach: api.sessions.detach,
    getWorkbench: api.workbench.get,
  };
}
