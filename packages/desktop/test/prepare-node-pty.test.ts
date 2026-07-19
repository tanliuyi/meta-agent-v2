import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureNodePtySpawnHelpersExecutable } from "../../../scripts/prepare-desktop-node-pty.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepare Desktop node-pty", () => {
  it("adds execute permissions to the packaged macOS spawn helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-node-pty-"));
    roots.push(root);
    const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
    await mkdir(join(root, "prebuilds", "darwin-arm64"), { recursive: true });
    await writeFile(helper, "helper");
    await chmod(helper, 0o644);

    expect(ensureNodePtySpawnHelpersExecutable(root, "darwin")).toEqual([helper]);
    expect((await stat(helper)).mode & 0o111).toBe(0o111);
    expect(ensureNodePtySpawnHelpersExecutable(root, "darwin")).toEqual([]);
  });
});
