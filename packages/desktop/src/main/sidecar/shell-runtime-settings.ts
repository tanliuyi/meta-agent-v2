import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify } from "jsonc-parser";
import lockfile from "proper-lockfile";

/** Persist the Desktop shell selection in the effective settings scope used by sidecars and terminals. */
export async function saveShellRuntimePath(cwd: string, agentDir: string, shellPath: string): Promise<void> {
  const settings = SettingsManager.create(cwd, agentDir);
  throwSettingsErrors(settings.drainErrors());

  if (settings.getProjectSettings().shellPath !== undefined) {
    await saveProjectShellPath(cwd, shellPath);
  } else {
    settings.setShellPath(shellPath);
    await settings.flush();
    throwSettingsErrors(settings.drainErrors());
  }
}

async function saveProjectShellPath(cwd: string, shellPath: string): Promise<void> {
  const settingsPath = join(cwd, ".pi", "settings.json");
  const release = await lockfile.lock(settingsPath, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 6, factor: 1.6, minTimeout: 50, maxTimeout: 500, randomize: true },
  });
  try {
    const source = await readFile(settingsPath, "utf8");
    const updated = applyEdits(
      source,
      modify(source, ["shellPath"], shellPath, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
    const tempPath = `${settingsPath}.${randomUUID()}.tmp`;
    const mode = (await stat(settingsPath)).mode;

    try {
      await writeFile(tempPath, updated, { encoding: "utf8", mode });
      await rename(tempPath, settingsPath);
    } finally {
      await rm(tempPath, { force: true });
    }
  } finally {
    await release();
  }
}

function throwSettingsErrors(errors: Array<{ scope: string; error: Error }>): void {
  if (errors.length === 0) return;
  throw new Error(
    `无法保存 Git Bash 路径: ${errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ")}`,
  );
}
