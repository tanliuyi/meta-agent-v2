import { basename } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBrowserOpenTarget } from "./src/configuration.ts";
import { openDesktopBrowser as openEmbeddedBrowser } from "./desktop-browser.ts";

const ignoreDesktopShortcut: ExtensionAPI["registerShortcut"] = () => {};

export interface DesktopApiOptions {
  openBrowser?: (url: string, options?: ExecOptions) => Promise<ExecResult>;
  toolNameAliases?: Readonly<Record<string, string>>;
}

export function createDesktopApi(pi: ExtensionAPI, options: DesktopApiOptions = {}): ExtensionAPI {
  const openBrowser = options.openBrowser ?? openEmbeddedBrowser;
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerShortcut") return ignoreDesktopShortcut;
      if (property === "registerTool") return registerDesktopTool(pi, options.toolNameAliases ?? {});
      if (property === "exec") {
        const exec = Reflect.get(target, property, receiver) as ExtensionAPI["exec"];
        if (typeof exec !== "function") return exec;
        return (command: string, args: string[], execOptions?: ExecOptions) => {
          const url = browserOpenUrl(command, args);
          if (url && getBrowserOpenTarget() === "builtin") return openBrowser(url, execOptions);
          return exec.call(target, command, args, execOptions);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function registerDesktopTool(
  pi: ExtensionAPI,
  toolNameAliases: Readonly<Record<string, string>>,
): ExtensionAPI["registerTool"] {
  return (tool) => {
    const desktopTool = { ...tool, name: toolNameAliases[tool.name] ?? tool.name };
    delete desktopTool.renderCall;
    delete desktopTool.renderResult;
    pi.registerTool(desktopTool);
  };
}

function browserOpenUrl(command: string, args: string[]): string | undefined {
  const executable = basename(command).toLowerCase();
  const matchesCommand =
    (process.platform === "darwin" && executable === "open") ||
    (process.platform === "win32" && executable === "cmd" && args[0]?.toLowerCase() === "/c") ||
    (process.platform !== "darwin" && process.platform !== "win32" && executable === "xdg-open");
  if (!matchesCommand) return undefined;
  const url = args.at(-1);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
