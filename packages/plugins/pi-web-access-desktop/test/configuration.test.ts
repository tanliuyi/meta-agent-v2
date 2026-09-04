import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyDesktopConfig,
  getBrowserOpenTarget,
  getRunCodeToolNameAliases,
  getWebSearchConfigPath,
  WEB_ACCESS_CONFIGURATION_SCHEMA,
} from "../src/configuration.ts";

const tempRoots: string[] = [];

function withTempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "web-access-config-"));
  tempRoots.push(root);
  const home = join(root, "home");
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return root;
}

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

test("schema is valid and flat-keyed", () => {
  assert.equal(WEB_ACCESS_CONFIGURATION_SCHEMA.version, 1);
  const keys = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.map((field) => field.key);
  assert.equal(keys.length, 63);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("searchProvider"));
  assert.ok(keys.includes("searchRouting.providers"));
  assert.ok(keys.includes("curatorRemote.enabled"));
  assert.ok(keys.includes("browser.openTarget"));
  assert.ok(keys.includes("searxngHeaders"));
  assert.ok(keys.includes("pdf.maxSizeMB"));
  assert.ok(keys.includes("toolNames.webSearch"));
  assert.ok(keys.includes("githubClone.enabled"));
  assert.ok(keys.includes("fetchContent.domainPolicy.allow"));
  const searchProvider = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "searchProvider");
  assert.equal(searchProvider?.type, "select");
  if (searchProvider?.type !== "select") throw new Error("searchProvider field is missing");
  assert.deepEqual(
    searchProvider.options.map((option) => option.value),
    [
      "auto",
      "all",
      "openai",
      "brave",
      "parallel",
      "tinyfish",
      "search1api",
      "searchinfinity",
      "querit",
      "tavily",
      "searxng",
      "perplexity",
      "gemini",
      "exa",
      "serpdive",
      "kagi",
      "ollama",
      "anysearch",
      "xai",
      "brightdata",
      "serpbase",
    ],
  );
  const browserOpenTarget = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find(
    (field) => field.key === "browser.openTarget",
  );
  assert.equal(browserOpenTarget?.type, "select");
  if (browserOpenTarget?.type !== "select") throw new Error("browser.openTarget field is missing");
  assert.deepEqual(browserOpenTarget.options.map((option) => option.value), ["builtin", "system"]);
  const searchModel = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "searchModel");
  assert.equal(searchModel?.widget, "model-selector");
  assert.equal(searchModel?.modelFormat, "model-id");
  const summaryModel = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find((field) => field.key === "summaryModel");
  assert.equal(summaryModel?.widget, "model-selector");
  assert.equal(summaryModel?.modelFormat, "provider-model");
  const serpdiveModel = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find(
    (field) => field.key === "serpdiveModel",
  );
  assert.equal(serpdiveModel?.type, "select");
  if (serpdiveModel?.type !== "select") throw new Error("serpdiveModel field is missing");
  assert.deepEqual(
    serpdiveModel.options.map((option) => option.value),
    ["krill", "mako", "moby"],
  );
  const curatorTimeout = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find(
    (field) => field.key === "curatorTimeoutSeconds",
  );
  assert.equal(curatorTimeout?.type, "number");
  if (curatorTimeout?.type !== "number") throw new Error("curatorTimeoutSeconds field is missing");
  assert.equal(curatorTimeout.maximum, 600);
  for (const key of ["firecrawlApiVersion", "firecrawlFreshScrape", "pdf.maxSizeMB"]) {
    const field = WEB_ACCESS_CONFIGURATION_SCHEMA.fields.find((candidate) => candidate.key === key);
    assert.ok(field);
    assert.equal("defaultValue" in field, false);
  }
  for (const field of WEB_ACCESS_CONFIGURATION_SCHEMA.fields) {
    assert.ok(field.key.length > 0);
    assert.ok(field.label.length > 0);
    assert.ok(["text", "textarea", "path", "secret", "number", "boolean", "select"].includes(field.type));
  }
});

test("market manifest identifies the local plugin as pi.web-access", async () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "market-manifest.json"), "utf8"),
  );
  assert.equal(manifest.plugin.id, "pi.web-access");
  assert.equal(manifest.pi.entry, "index.ts");
  assert.equal(manifest.desktop.hostProfileVersion, 1);
  assert.deepEqual(manifest.configuration, WEB_ACCESS_CONFIGURATION_SCHEMA);
  assert.deepEqual(manifest.capabilities, [
    "events.subscribe",
    "configuration.read",
    "plugin-methods.provide",
    "commands.register",
    "messages.enqueue",
    "messages.custom",
    "session.read",
    "ui.notify",
    "ui.dialog",
    "ui.widget.text",
  ]);
});

test("applyDesktopConfig writes only explicitly set values", () => {
  withTempHome();
  applyDesktopConfig({ searchProvider: "exa", openaiApiKey: "sk-test-key" });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.equal(config.searchProvider, "exa");
  assert.equal(config.openaiApiKey, "sk-test-key");
});

function prewriteConfig(value: unknown): void {
  const path = getWebSearchConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("applyDesktopConfig merges nested fields and preserves existing config", () => {
  withTempHome();
  prewriteConfig({ toolNames: { fetch: "x" }, githubClone: { enabled: false } });
  applyDesktopConfig({
    "browser.openTarget": "builtin",
    "githubClone.enabled": true,
    "githubClone.maxRepoSizeMB": 500,
    "video.preferredModel": "gemini-3.6-flash",
    "pdf.maxSizeMB": 30,
    "searchRouting.providers": "brave\nexa",
    "searchRouting.fallbackOn": "transient\nnetwork",
    "toolNames.fetchContent": "desktop_fetch",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.toolNames, { fetch: "x", fetchContent: "desktop_fetch" });
  assert.deepEqual(config.githubClone, { enabled: true, maxRepoSizeMB: 500 });
  assert.equal(config.browser.openTarget, "builtin");
  assert.equal(config.video.preferredModel, "gemini-3.6-flash");
  assert.equal(config.pdf.maxSizeMB, 30);
  assert.deepEqual(config.searchRouting, {
    providers: ["brave", "exa"],
    fallbackOn: ["transient", "network"],
  });
  assert.equal(config.toolNames.fetchContent, "desktop_fetch");
});

test("getBrowserOpenTarget reads the configured browser target", () => {
  withTempHome();
  applyDesktopConfig({ "browser.openTarget": "builtin" });
  assert.equal(getBrowserOpenTarget(), "builtin");
});

test("getRunCodeToolNameAliases maps configured names to the stable plugin API", () => {
  withTempHome();
  prewriteConfig({
    toolNames: {
      webSearch: "custom_search",
      sourceCheck: "custom_check",
      fetchContent: "fetch_content",
    },
  });

  assert.deepEqual(getRunCodeToolNameAliases(), {
    custom_search: "web_search",
    custom_check: "source_check",
  });
});

test("applyDesktopConfig serializes structured upstream settings", () => {
  withTempHome();
  applyDesktopConfig({
    "curatorRemote.enabled": true,
    "curatorRemote.host": "desktop.example.test",
    "curatorRemote.bind": "0.0.0.0",
    searxngHeaders:
      "Authorization: Bearer test\nX-Tenant: desktop\nX-Invalid: value\u0000\ninvalid-line",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.curatorRemote, { host: "desktop.example.test", bind: "0.0.0.0" });
  assert.deepEqual(config.searxngHeaders, {
    Authorization: "Bearer test",
    "X-Tenant": "desktop",
  });
});

test("applyDesktopConfig preserves structured settings when form fields are empty", () => {
  withTempHome();
  prewriteConfig({
    curatorRemote: { host: "old.example.test", bind: "127.0.0.1" },
    searchRouting: { providers: ["brave"], fallbackOn: ["network"] },
  });
  applyDesktopConfig({
    "curatorRemote.enabled": true,
    "curatorRemote.host": "new.example.test",
    "curatorRemote.bind": "",
    "searchRouting.providers": "",
    "searchRouting.fallbackOn": "",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.curatorRemote, {
    host: "new.example.test",
    bind: "127.0.0.1",
  });
  assert.deepEqual(config.searchRouting, {
    providers: ["brave"],
    fallbackOn: ["network"],
  });
});

test("applyDesktopConfig does not create incomplete search routing", () => {
  withTempHome();
  applyDesktopConfig({
    "searchRouting.providers": "brave\nexa",
    "searchRouting.fallbackOn": "",
  });
  assert.throws(() => readFileSync(getWebSearchConfigPath(), "utf8"), { code: "ENOENT" });
});

test("getWebSearchConfigPath follows upstream environment priority", () => {
  const root = withTempHome();
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  assert.equal(getWebSearchConfigPath(), join(root, "xdg", "pi", "web-search.json"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  assert.equal(getWebSearchConfigPath(), join(root, "agent", "web-search.json"));
});

test("applyDesktopConfig splits textarea fields into arrays", () => {
  withTempHome();
  applyDesktopConfig({
    "fetchContent.domainPolicy.allow": "example.com\nopenai.com",
    "fetchContent.domainPolicy.deny": "blocked.example.com",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.fetchContent.domainPolicy.allow, ["example.com", "openai.com"]);
  assert.deepEqual(config.fetchContent.domainPolicy.deny, ["blocked.example.com"]);
});

test("applyDesktopConfig ignores empty strings and undefined", () => {
  withTempHome();
  prewriteConfig({ searchModel: "gemini-2.5-flash" });
  applyDesktopConfig({ searchModel: "", openaiApiKey: undefined });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.equal(config.searchModel, "gemini-2.5-flash");
  assert.equal(config.openaiApiKey, undefined);
});

test("applyDesktopConfig does nothing without values", () => {
  withTempHome();
  applyDesktopConfig(undefined);
  assert.throws(() => readFileSync(getWebSearchConfigPath(), "utf8"), { code: "ENOENT" });
  applyDesktopConfig({});
  assert.throws(() => readFileSync(getWebSearchConfigPath(), "utf8"), { code: "ENOENT" });
});
