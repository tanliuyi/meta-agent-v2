import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDevelopmentEntry } from "../src/main/extensions/desktop-extension-directory.ts";

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins/billion-context-pi");

describe("Billion Context development manifest", () => {
  it("exposes the Desktop configuration schema through the development resolver", async () => {
    const entry = await resolveDevelopmentEntry(pluginDirectory);

    expect(entry.displayName).toBe("Billion Context");
    expect(entry.pluginId).toBe("pi.billion-context");
    expect(entry.capabilities).toEqual(
      expect.arrayContaining(["configuration.read", "events.subscribe", "tools.register"]),
    );
    expect(entry.configurationSchema?.version).toBe(1);
    expect(entry.configurationSchema?.fields.map(({ key }) => key)).toEqual([
      "modelContextLimit",
      "preserveRecentMessages",
      "toolBashDefaultTimeout",
      "toolOutputMaxBytes",
      "debug",
    ]);
  });
});
