import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeExtensionPath } from "../src/main/pi/extensions/pi-subagents/src/runs/shared/pi-args.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-args-ext-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("resolveRuntimeExtensionPath", () => {
  it("prefers the .ts source when it exists (npm package layout)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "entry.ts"), "");
    expect(resolveRuntimeExtensionPath("entry.ts", dir)).toBe(join(dir, "entry.ts"));
  });

  it("falls back to the compiled .js sibling when the .ts source is absent (sidecar layout)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "entry.js"), "");
    expect(resolveRuntimeExtensionPath("entry.ts", dir)).toBe(join(dir, "entry.js"));
  });

  it("returns the .ts path when neither form exists, preserving the original error", () => {
    const dir = tempDir();
    expect(resolveRuntimeExtensionPath("entry.ts", dir)).toBe(join(dir, "entry.ts"));
  });

  it("keeps the same fallback for nested relative paths (fanout-child)", () => {
    const dir = join(tempDir(), "runs", "shared");
    const relative = join("..", "..", "extension", "fanout-child.ts");
    mkdirSync(dir, { recursive: true });
    const jsPath = join(dir, relative.replace(/\.ts$/, ".js"));
    mkdirSync(join(dir, "..", "..", "extension"), { recursive: true });
    writeFileSync(jsPath, "");
    expect(resolveRuntimeExtensionPath(relative, dir)).toBe(jsPath);
  });
});
