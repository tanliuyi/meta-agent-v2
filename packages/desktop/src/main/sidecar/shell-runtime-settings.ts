import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Persist the Desktop shell selection in the effective settings scope used by sidecars and terminals. */
export async function saveShellRuntimePath(cwd: string, agentDir: string, path: string): Promise<void> {
  const settings = SettingsManager.create(cwd, agentDir);
  throwSettingsErrors(settings.drainErrors());

  if (settings.getProjectSettings().shellPath !== undefined) settings.setProjectShellPath(path);
  else settings.setShellPath(path);

  await settings.flush();
  throwSettingsErrors(settings.drainErrors());
}

function throwSettingsErrors(errors: Array<{ scope: string; error: Error }>): void {
  if (errors.length === 0) return;
  throw new Error(
    `无法保存 Git Bash 路径: ${errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ")}`,
  );
}
