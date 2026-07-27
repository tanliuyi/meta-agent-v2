import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ignoreDesktopShortcut: ExtensionAPI["registerShortcut"] = () => {};

export function createDesktopApi(pi: ExtensionAPI): ExtensionAPI {
  const registerDesktopTool: ExtensionAPI["registerTool"] = (tool) => {
    const desktopTool = { ...tool };
    delete desktopTool.renderCall;
    delete desktopTool.renderResult;
    pi.registerTool(desktopTool);
  };

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerShortcut") return ignoreDesktopShortcut;
      if (property === "registerTool") return registerDesktopTool;
      return Reflect.get(target, property, receiver);
    },
  });
}
