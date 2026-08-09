import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUserConfig, type UserAcpConfig } from "../src/user-config.ts";

test("Desktop host values stay ahead of acp.json values", () => {
  const adapter = {
    debug: false,
    modelContextLimit: 200_000,
    toolBashDefaultTimeout: 60,
    toolOutputMaxBytes: 200_000,
    preserveRecentMessages: 5,
  };
  const user: UserAcpConfig = {
    debug: true,
    modelContextLimit: 100_000,
    toolBashDefaultTimeout: 10,
    toolOutputMaxBytes: 10_000,
    autoUpdate: true,
  };
  const protectedKeys = new Set<keyof UserAcpConfig>([
    "debug",
    "modelContextLimit",
    "toolBashDefaultTimeout",
    "toolOutputMaxBytes",
  ]);

  const result = applyUserConfig(adapter, user, protectedKeys);
  assert.equal(result.debug, false);
  assert.equal(result.modelContextLimit, 200_000);
  assert.equal(result.toolBashDefaultTimeout, 60);
  assert.equal(result.toolOutputMaxBytes, 200_000);
  assert.equal(result.preserveRecentMessages, 5);
  assert.equal(result.autoUpdate, true);
});

test("standard Pi config remains user-overridable without host values", () => {
  const result = applyUserConfig({ modelContextLimit: 200_000 }, { modelContextLimit: 100_000 });
  assert.equal(result.modelContextLimit, 100_000);
});

test("Desktop root keeps autoUpdate disabled", () => {
  const result = applyUserConfig({ autoUpdate: false }, { autoUpdate: true });
  assert.equal(result.autoUpdate, false);
});
