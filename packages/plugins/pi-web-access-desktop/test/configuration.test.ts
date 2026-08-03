import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";import test from "node:test";
import {
  applyDesktopConfig,
  getWebSearchConfigPath,
  WEB_ACCESS_CONFIGURATION_SCHEMA,
} from "../src/configuration.ts";

const tempRoots: string[] = [];

function withTempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "web-access-config-"));
  tempRoots.push(root);
  const home = join(root, "home");
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
  assert.ok(keys.length <= 64);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("searchProvider"));
  assert.ok(keys.includes("githubClone.enabled"));
  assert.ok(keys.includes("ssrf.allowRanges"));
  for (const field of WEB_ACCESS_CONFIGURATION_SCHEMA.fields) {
    assert.ok(field.key.length > 0);
    assert.ok(field.label.length > 0);
    assert.ok(["text", "textarea", "path", "secret", "number", "boolean", "select"].includes(field.type));
  }
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
    "githubClone.enabled": true,
    "githubClone.maxRepoSizeMB": 500,
    "video.preferredModel": "gemini-2.5-flash",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.toolNames, { fetch: "x" });
  assert.deepEqual(config.githubClone, { enabled: true, maxRepoSizeMB: 500 });
  assert.equal(config.video.preferredModel, "gemini-2.5-flash");
});

test("applyDesktopConfig splits textarea fields into arrays", () => {
  withTempHome();
  applyDesktopConfig({
    "ssrf.allowRanges": "10.0.0.0/8\n192.168.0.0/16",
    "fetchContent.domainPolicy.deny": "example.com",
  });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.deepEqual(config.ssrf.allowRanges, ["10.0.0.0/8", "192.168.0.0/16"]);
  assert.deepEqual(config.fetchContent.domainPolicy.deny, ["example.com"]);
});

test("applyDesktopConfig ignores empty strings and undefined", () => {
  withTempHome();
  prewriteConfig({ searchModel: "gemini-2.5-flash" });
  applyDesktopConfig({ searchModel: "", openaiApiKey: undefined });
  const config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  assert.equal(config.searchModel, "gemini-2.5-flash");
  assert.equal(config.openaiApiKey, undefined);
});

test("applyDesktopConfig does nothing without config", () => {
  withTempHome();
  applyDesktopConfig(undefined);
  assert.throws(() => readFileSync(getWebSearchConfigPath(), "utf8"), { code: "ENOENT" });
});
