import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { synchronizeDesktopSidecarOutput } from "../../../scripts/clean-desktop-sidecar-output.mjs";
import { copyDesktopSidecarAssets } from "../../../scripts/copy-desktop-sidecar-assets.mjs";

describe("Desktop sidecar build cleanup", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("replaces a sidecar build and removes stale generated files and assets", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-sidecar-clean-"));
    temporaryDirectories.push(root);
    const stagedRoot = join(root, "staged");
    const outputRoot = join(root, "out", "sidecar");
    const currentWorker = join(outputRoot, "sidecar", "metadata-worker-main.js");
    const staleWorker = join(outputRoot, "sidecar", "projection-worker-main.js");
    const staleAsset = join(outputRoot, "main", "pi", "skills", "removed", "SKILL.md");
    mkdirSync(join(stagedRoot, "sidecar"), { recursive: true });
    mkdirSync(join(outputRoot, "sidecar"), { recursive: true });
    mkdirSync(dirname(staleAsset), { recursive: true });
    writeFileSync(join(stagedRoot, "sidecar", "metadata-worker-main.js"), "current");
    writeFileSync(join(stagedRoot, "runtime-manifest.json"), "manifest");
    writeFileSync(currentWorker, "old");
    writeFileSync(staleWorker, "stale");
    writeFileSync(staleAsset, "stale");

    synchronizeDesktopSidecarOutput(stagedRoot, outputRoot);

    expect(readFileSync(currentWorker, "utf8")).toBe("current");
    expect(readFileSync(join(outputRoot, "runtime-manifest.json"), "utf8")).toBe("manifest");
    expect(existsSync(staleWorker)).toBe(false);
    expect(existsSync(staleAsset)).toBe(false);
  });

  it("copies built-in Desktop skills into the sidecar output", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-sidecar-assets-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "out", "sidecar");

    copyDesktopSidecarAssets(outputRoot);

    const skillsRoot = join(outputRoot, "main", "pi", "skills");
    expect(readFileSync(join(skillsRoot, "plugin-create", "SKILL.md"), "utf8")).toContain("name: plugin-create");
    expect(readFileSync(join(skillsRoot, "plugin-publish", "SKILL.md"), "utf8")).toContain("name: plugin-publish");
    expect(readFileSync(join(skillsRoot, "desktop-plugin-development", "SKILL.md"), "utf8")).toContain(
      "name: desktop-plugin-development",
    );
    expect(
      readFileSync(join(skillsRoot, "desktop-plugin-development", "references", "configuration-schema.md"), "utf8"),
    ).toContain("Desktop Configuration Schema v1");
    expect(
      readFileSync(join(skillsRoot, "desktop-plugin-development", "references", "host-profile.md"), "utf8"),
    ).toContain("Desktop Host Profile v1");
    expect(
      readFileSync(join(skillsRoot, "desktop-plugin-development", "references", "loading-and-packaging.md"), "utf8"),
    ).toContain("Loading and Packaging");
    expect(readFileSync(join(skillsRoot, "plugin-publish", "references", "API.md"), "utf8")).toContain(
      "Marketplace Publish API v1",
    );
    expect(existsSync(join(outputRoot, "main", "pi", "extensions", "pi-subagents", "skills"))).toBe(true);
    const subagentsRoot = join(outputRoot, "main", "pi", "extensions", "pi-subagents");
    expect(readFileSync(join(subagentsRoot, "README.md"), "utf8")).toContain("# pi-subagents");
    expect(readFileSync(join(subagentsRoot, "CHANGELOG.md"), "utf8")).toContain("## [0.47.0]");
    expect(readFileSync(join(subagentsRoot, "package.json"), "utf8")).toContain('"name": "pi-subagents"');
    expect(readFileSync(join(subagentsRoot, "install.mjs"), "utf8")).toContain("pi-subagents installer");
    expect(readFileSync(join(subagentsRoot, "docs", "workflows.md"), "utf8")).toContain("workflow");
  });
});
