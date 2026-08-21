import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveShellRuntimePath } from "../src/main/sidecar/shell-runtime-settings.ts";
import { getSystemPiShellPath } from "../src/main/sidecar/system-pi-settings.ts";

describe("shell runtime settings", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "desktop-shell-settings-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists an installed Bash path in the sidecar user settings", async () => {
    const shellPath = join(root, "shell-runtime", "bin", "bash.exe");

    await saveShellRuntimePath(cwd, agentDir, shellPath);

    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ shellPath });
    expect(getSystemPiShellPath(cwd, agentDir)).toBe(shellPath);
  });

  it("updates a project shell override in its effective scope", async () => {
    const globalShellPath = join(root, "global", "bash.exe");
    const projectShellPath = join(root, "project", "bash.exe");
    const replacementShellPath = join(root, "replacement", "bash.exe");
    const projectSettingsDir = join(cwd, ".pi");
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: globalShellPath }));
    writeFileSync(join(projectSettingsDir, "settings.json"), JSON.stringify({ shellPath: projectShellPath }));

    await saveShellRuntimePath(cwd, agentDir, replacementShellPath);

    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).shellPath).toBe(globalShellPath);
    expect(JSON.parse(readFileSync(join(projectSettingsDir, "settings.json"), "utf8")).shellPath).toBe(
      replacementShellPath,
    );
    expect(getSystemPiShellPath(cwd, agentDir)).toBe(replacementShellPath);
  });

  it("re-reads settings after acquiring the system Pi lock", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
    const release = await lockfile.lock(settingsPath, { realpath: false });
    const saving = saveShellRuntimePath(cwd, agentDir, join(root, "bash.exe"));
    writeFileSync(settingsPath, JSON.stringify({ theme: "light", customField: true }));
    await release();

    await saving;

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      theme: "light",
      customField: true,
      shellPath: join(root, "bash.exe"),
    });
  });

  it("rejects a shell selection when settings cannot be loaded", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, "{ invalid json");

    await expect(saveShellRuntimePath(cwd, agentDir, join(root, "bash.exe"))).rejects.toThrow(
      "Invalid system Pi settings",
    );
    expect(readFileSync(settingsPath, "utf8")).toBe("{ invalid json");
  });
});
