import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMarketplaceExtensionRoot } from "../src/main/plugins/marketplace-extension-root.ts";

describe("resolveMarketplaceExtensionRoot", () => {
  it("keeps Desktop marketplace payloads outside the shared Pi agent directory", () => {
    const userDataDir = join("tmp", "meta-agent-user-data");

    expect(resolveMarketplaceExtensionRoot(userDataDir)).toBe(join(userDataDir, "plugins", "extensions"));
  });
});
