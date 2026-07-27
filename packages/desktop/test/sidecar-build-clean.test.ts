import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanDesktopSidecarOutput } from "../../../scripts/clean-desktop-sidecar-output.mjs";
import { copyDesktopSidecarAssets } from "../../../scripts/copy-desktop-sidecar-assets.mjs";

describe("Desktop sidecar build cleanup", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("removes outputs left behind by deleted sidecar sources", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-sidecar-clean-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "out", "sidecar");
    const staleWorker = join(outputRoot, "sidecar", "projection-worker-main.js");
    mkdirSync(join(outputRoot, "sidecar"), { recursive: true });
    writeFileSync(staleWorker, "stale");

    cleanDesktopSidecarOutput(outputRoot);

    expect(existsSync(outputRoot)).toBe(false);
  });

  it("copies built-in Desktop skills into the sidecar output", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-sidecar-assets-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "out", "sidecar");

    copyDesktopSidecarAssets(outputRoot);

    const skillsRoot = join(outputRoot, "main", "pi", "skills");
    expect(readFileSync(join(skillsRoot, "plugin-create", "SKILL.md"), "utf8")).toContain("name: plugin-create");
    expect(readFileSync(join(skillsRoot, "plugin-publish", "SKILL.md"), "utf8")).toContain("name: plugin-publish");
    expect(readFileSync(join(skillsRoot, "plugin-publish", "references", "API.md"), "utf8")).toContain(
      "Marketplace Publish API v1",
    );
    expect(existsSync(join(outputRoot, "main", "pi", "extensions", "pi-subagents", "skills"))).toBe(true);
  });
});
