import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { binaryFileName, detectAsset, ensureBinary } from "../src/binary.ts";
import { DEFAULT_VERSION, resolveConfig } from "../src/config.ts";

function tempConfig(raw?: Record<string, string | number | boolean>) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-officecli-test-"));
  const config = resolveConfig({ ...raw, dataDir: path.join(dir, "bin") });
  return { config, dir };
}

test("detectAsset maps platform/arch to release assets", () => {
  assert.equal(detectAsset("darwin", "arm64"), "officecli-mac-arm64");
  assert.equal(detectAsset("darwin", "x64"), "officecli-mac-x64");
  assert.equal(detectAsset("linux", "x64"), "officecli-linux-x64");
  assert.equal(detectAsset("linux", "arm64"), "officecli-linux-arm64");
  assert.equal(detectAsset("win32", "x64"), "officecli-win-x64.exe");
  assert.equal(detectAsset("win32", "arm64"), "officecli-win-arm64.exe");
  assert.equal(detectAsset("freebsd", "x64"), null);
  assert.equal(detectAsset("win32", "ia32"), null);
});

test("binaryFileName uses .exe on Windows", () => {
  assert.equal(binaryFileName("win32"), "officecli.exe");
  assert.equal(binaryFileName("linux"), "officecli");
  assert.equal(binaryFileName("darwin"), "officecli");
});

test("resolveConfig applies defaults", () => {
  const config = resolveConfig(undefined);
  assert.equal(config.version, DEFAULT_VERSION);
  assert.equal(config.autoDownload, true);
  assert.equal(config.binaryPath, "");
  assert.ok(config.dataDir.endsWith("officecli"));
});
test("resolveConfig normalizes user overrides", () => {
  const config = resolveConfig({
    binaryPath: "C:/tools/officecli.exe",
    version: "1.0.100",
    autoDownload: false,
  });
  assert.equal(config.binaryPath, "C:/tools/officecli.exe");
  assert.equal(config.version, "v1.0.100");
  assert.equal(config.autoDownload, false);
});

test("ensureBinary returns the configured binaryPath without downloading", async () => {
  const config = resolveConfig({ binaryPath: process.execPath });
  const result = await ensureBinary(config);
  assert.equal(result, process.execPath);
});

test("ensureBinary rejects a missing configured binaryPath", async () => {
  const config = resolveConfig({ binaryPath: "Z:/definitely/not/here/officecli.exe" });
  await assert.rejects(ensureBinary(config), /binaryPath 指向的文件不存在/);
});

test("ensureBinary honors autoDownload=false when binary is missing", async () => {
  const { config, dir } = tempConfig({ autoDownload: false, version: "v0.0.0-never" });
  try {
    await assert.rejects(ensureBinary(config), /autoDownload 已关闭/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureBinary reuses an existing downloaded binary without re-downloading", async () => {
  const { config, dir } = tempConfig({ version: "v0.0.0-never" });
  try {
    const target = path.join(config.dataDir, binaryFileName());
    // Reuse the current node executable as a stand-in "existing binary".
    mkdirSync(config.dataDir, { recursive: true });
    copyFileSync(process.execPath, target);
    chmodSync(target, 0o755);
    const result = await ensureBinary(config);
    assert.equal(result, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
