import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodexMarketplace, resolvePersonalMarketplacePath } from "../src/main/plugins/codex/codex-marketplace.ts";

const fixtures = join(import.meta.dirname, "fixtures", "codex", "marketplaces");

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "curated", plugins: [], ...overrides };
}

function entry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, source: { source: "local", path: `./plugins/${name}` }, ...extra };
}

async function readOpenAiCurated(): Promise<string> {
  return readFile(join(fixtures, "openai-curated.json"), "utf8");
}

describe("parseCodexMarketplace", () => {
  it("parses a real openai-curated marketplace file", async () => {
    const result = parseCodexMarketplace(await readOpenAiCurated());
    expect(result.issues).toEqual([]);
    const marketplace = result.marketplace;
    expect(marketplace).toBeDefined();
    expect(marketplace?.name).toBe("openai-curated");
    expect(marketplace?.interface?.displayName).toBe("Codex official");
    expect(marketplace?.plugins.length).toBe(64);
    const first = marketplace?.plugins[0];
    expect(first?.name).toBe("linear");
    expect(first?.source).toEqual({ source: "local", path: "./plugins/linear" });
    expect(first?.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
    expect(first?.category).toBe("Productivity");
  });

  it("tolerates the real file's extra entry fields (category, interface, products)", async () => {
    const result = parseCodexMarketplace(await readOpenAiCurated());
    expect(result.issues).toEqual([]);
    const figma = result.marketplace?.plugins.find((plugin) => plugin.name === "figma");
    expect(figma?.category).toBe("Creativity");
    const foundry = result.marketplace?.plugins.find((plugin) => plugin.name === "crowdstrike-falcon-foundry");
    expect(foundry?.source).toEqual({ source: "url", url: "https://github.com/CrowdStrike/foundry-skills.git" });
    expect(foundry?.interface?.displayName).toBe("CrowdStrike Falcon Foundry");
    expect(foundry?.category).toBe("Developer Tools");
    const gameStudio = result.marketplace?.plugins.find((plugin) => plugin.name === "game-studio");
    expect(gameStudio?.policy?.products).toContain("CODEX");
    const crowdstrike = result.marketplace?.plugins.find((plugin) => plugin.name === "crowdstrike-falcon-fusion");
    expect(crowdstrike?.source).toEqual({ source: "url", url: "https://github.com/CrowdStrike/fusion-skills.git" });
  });

  it("passes a minimal single-plugin marketplace", () => {
    const result = parseCodexMarketplace(
      JSON.stringify({
        name: "personal",
        plugins: [{ name: "my-plugin", source: { source: "local", path: "./plugins/my-plugin" } }],
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.marketplace?.plugins).toHaveLength(1);
  });

  it("parses a real openai-api-curated marketplace file", async () => {
    const result = parseCodexMarketplace(await readFile(join(fixtures, "openai-api-curated.json"), "utf8"));
    expect(result.issues).toEqual([]);
    expect(result.marketplace?.plugins.length).toBe(48);
  });

  it("rejects malformed JSON and non-object roots", () => {
    expect(parseCodexMarketplace("{oops")).toEqual({ issues: [{ path: "$", message: "must be valid JSON" }] });
    expect(parseCodexMarketplace("42")).toEqual({ issues: [{ path: "$", message: "must contain a JSON object" }] });
  });

  it("validates the marketplace name", () => {
    for (const name of ["", "my market", "my.market"]) {
      const result = parseCodexMarketplace(JSON.stringify(manifest({ name })));
      expect(result.issues.some((issue) => issue.path === "$.name")).toBe(true);
    }
    const valid = parseCodexMarketplace(JSON.stringify(manifest({ name: "My_Market-1" })));
    expect(valid.issues).toEqual([]);
  });

  it("validates the plugins array", () => {
    const notArray = parseCodexMarketplace(JSON.stringify(manifest({ plugins: "nope" })));
    expect(notArray.issues).toEqual([{ path: "$.plugins", message: "must be an array" }]);
    const missing = parseCodexMarketplace(JSON.stringify({ name: "curated" }));
    expect(missing.issues).toEqual([{ path: "$.plugins", message: "must be an array" }]);
  });

  it("validates entry names", () => {
    const result = parseCodexMarketplace(JSON.stringify(manifest({ plugins: [entry("bad name")] })));
    expect(result.issues).toEqual([
      { path: "$.plugins[0].name", message: "must match `[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*`" },
    ]);
  });

  it("validates entry sources", () => {
    const noSource = parseCodexMarketplace(JSON.stringify(manifest({ plugins: [{ name: "p" }] })));
    expect(noSource.issues).toEqual([{ path: "$.plugins[0].source", message: "must be an object" }]);
    const noPathOrUrl = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [{ name: "p", source: { source: "local" } }] })),
    );
    expect(noPathOrUrl.issues).toEqual([
      { path: "$.plugins[0].source", message: "must declare a local `path` or a `url`" },
    ]);
    const badSourceType = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("p", { source: { source: "urgent" } })] })),
    );
    expect(badSourceType.issues).toEqual([
      { path: "$.plugins[0].source", message: "must declare a local `path` or a `url`" },
    ]);
  });

  it("rejects absolute and traversing local paths", () => {
    for (const path of ["C:\\outside", "/outside", "../outside", "..\\outside", "plugins/../../escape"]) {
      const result = parseCodexMarketplace(
        JSON.stringify(manifest({ plugins: [entry("p", { source: { source: "local", path } })] })),
      );
      expect(result.issues).toEqual([
        { path: "$.plugins[0].source.path", message: "must be a non-empty relative path" },
      ]);
    }
  });

  it("keeps local paths verbatim and accepts url entries", () => {
    const result = parseCodexMarketplace(
      JSON.stringify(
        manifest({
          plugins: [
            entry("a", { source: { source: "local", path: ".\\plugins\\a" } }),
            entry("b", { source: { source: "url", url: "https://example.com/plugin.git" } }),
          ],
        }),
      ),
    );
    expect(result.issues).toEqual([]);
    expect(result.marketplace?.plugins[0]?.source.path).toBe(".\\plugins\\a");
    expect(result.marketplace?.plugins[1]?.source.url).toBe("https://example.com/plugin.git");
  });

  it("validates policies", () => {
    const badInstallation = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("p", { policy: { installation: "MAYBE" } })] })),
    );
    expect(badInstallation.issues).toEqual([
      {
        path: "$.plugins[0].policy.installation",
        message: "must be one of `NOT_AVAILABLE`, `AVAILABLE`, `INSTALLED_BY_DEFAULT`",
      },
    ]);
    const badAuthentication = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("p", { policy: { authentication: "ALWAYS" } })] })),
    );
    expect(badAuthentication.issues).toEqual([
      { path: "$.plugins[0].policy.authentication", message: "must be one of `ON_INSTALL`, `ON_USE`" },
    ]);
    const badProducts = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("p", { policy: { products: ["CODEX", 3] } })] })),
    );
    expect(badProducts.issues).toEqual([
      { path: "$.plugins[0].policy.products", message: "must be an array of strings" },
    ]);
    const valid = parseCodexMarketplace(
      JSON.stringify(
        manifest({
          plugins: [
            entry("p", {
              policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL", products: ["CODEX"] },
            }),
          ],
        }),
      ),
    );
    expect(valid.issues).toEqual([]);
  });

  it("validates the top-level and entry interfaces", () => {
    const badTop = parseCodexMarketplace(JSON.stringify(manifest({ interface: { displayName: 42 } })));
    expect(badTop.issues).toEqual([{ path: "$.interface.displayName", message: "must be a non-empty string" }]);
    const badEntry = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("p", { interface: { displayName: "" } })] })),
    );
    expect(badEntry.issues).toEqual([
      { path: "$.plugins[0].interface.displayName", message: "must be a non-empty string" },
    ]);
  });

  it("tolerates unknown top-level and entry fields", () => {
    const result = parseCodexMarketplace(
      JSON.stringify(
        manifest({
          interface: { displayName: "OpenAI Curated" },
          plugins: [entry("p", { anything: { deep: [1, 2] } })],
          someFutureField: true,
        }),
      ),
    );
    expect(result.issues).toEqual([]);
    expect(result.marketplace?.plugins[0]?.name).toBe("p");
  });

  it("reports structured issues and keeps invalid-name entries", () => {
    const result = parseCodexMarketplace(
      JSON.stringify(manifest({ plugins: [entry("good"), entry("bad name"), 7, entry("also-good")] })),
    );
    expect(result.issues).toEqual([
      { path: "$.plugins[1].name", message: "must match `[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*`" },
      { path: "$.plugins[2]", message: "must be an object" },
    ]);
    expect(result.marketplace?.plugins.map((plugin) => plugin.name)).toEqual(["good", "bad name", "also-good"]);
  });
});

describe("resolvePersonalMarketplacePath", () => {
  it("resolves under the user profile .agents directory", () => {
    expect(resolvePersonalMarketplacePath("C:\\Users\\Test")).toBe(
      join("C:\\Users\\Test", ".agents", "plugins", "marketplace.json"),
    );
    expect(resolvePersonalMarketplacePath("/home/test")).toBe(
      join("/home/test", ".agents", "plugins", "marketplace.json"),
    );
  });

  it("uses the current user home by default", () => {
    expect(resolvePersonalMarketplacePath()).toBe(join(homedir(), ".agents", "plugins", "marketplace.json"));
  });
});
