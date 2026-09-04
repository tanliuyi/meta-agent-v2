import { join } from "node:path";
import { safeStorage } from "electron";
import type {
  BrowserCloseTabRequest,
  BrowserCreateTabRequest,
  BrowserStateEvent,
} from "../../shared/browser-contracts.ts";
import type { BrowserPasswordOffer } from "../../shared/browser-data-contracts.ts";
import { BrowserDataService } from "../browser/browser-data-service.ts";
import { type BrowserHostServer, createBrowserHostServer } from "../browser/browser-host-server.ts";
import { handleBrowserInternalPageRequests } from "../browser/browser-internal-page-protocol.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import type { BrowserCapabilityPort } from "../session/browser-capability-port.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";

/** 浏览器数据、会话管理器和 host server 服务集合。 */
export interface BrowserServices {
  readonly data: BrowserDataService;
  readonly manager: BrowserManager;
  readonly hostServer: BrowserHostServer;
  dispose(): Promise<void>;
}

/** 浏览器服务构造所需的 capability port 和 renderer 回调。 */
export interface BrowserServicesOptions {
  readonly context: DesktopRuntimeContext;
  readonly capability: BrowserCapabilityPort;
  readonly rendererUrl?: string;
  readonly publishState: (event: BrowserStateEvent) => void;
  readonly publishCreateTab: (request: BrowserCreateTabRequest) => void;
  readonly publishCloseTab: (request: BrowserCloseTabRequest) => void;
  readonly publishPasswordOffer: (offer: BrowserPasswordOffer, ownerWebContentsId: number) => void;
}

/** 构造浏览器数据、manager 和 loopback host，并绑定 session capability。 */
/** 启动 browser host，并将其 endpoint 和 capability 注入服务图。 */
export async function createBrowserServices(options: BrowserServicesOptions): Promise<BrowserServices> {
  const { context } = options;
  const data = new BrowserDataService(context.userDataDir, {
    crypto: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
    log: (text) => context.sidecarLog.write("browser", text),
  });
  const manager = new BrowserManager(context.userDataDir, {
    onStateChanged: options.publishState,
    onCreateTabRequest: options.publishCreateTab,
    onCloseTabRequest: options.publishCloseTab,
    onPasswordOffer: options.publishPasswordOffer,
    data,
    onSessionCreated: (browserSession) =>
      handleBrowserInternalPageRequests(join(context.appDir, "../renderer"), options.rendererUrl, browserSession),
    log: (text) => context.sidecarLog.write("browser", text),
  });
  options.capability.bind(manager);
  let hostServer: BrowserHostServer;
  try {
    hostServer = await createBrowserHostServer(manager, {
      log: (text) => context.sidecarLog.write("browser-host", text),
    });
  } catch (error) {
    options.capability.unbind(manager);
    manager.dispose();
    throw error;
  }
  const endpoint = hostServer.getEndpoint();
  if (endpoint) {
    process.env.PI_BROWSER_HOST_PORT = String(endpoint.port);
    process.env.PI_BROWSER_TOKEN = endpoint.token;
  }
  let disposal: Promise<void> | undefined;
  return {
    data,
    manager,
    hostServer,
    dispose(): Promise<void> {
      disposal ??= (async () => {
        delete process.env.PI_BROWSER_HOST_PORT;
        delete process.env.PI_BROWSER_TOKEN;
        const errors: unknown[] = [];
        for (const [name, dispose] of [
          ["browser capability", () => options.capability.unbind(manager)],
          ["browser host", () => hostServer.dispose()],
          ["browser manager", () => manager.dispose()],
        ] as const) {
          try {
            await dispose();
          } catch (error) {
            errors.push(new Error(`Failed to dispose ${name}`, { cause: error }));
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose browser services");
      })();
      return disposal;
    },
  };
}
