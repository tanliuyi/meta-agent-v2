import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ShellRuntimeProgress } from "../../shared/desktop-api.ts";
import { ShellRuntimeInstaller } from "./shell-runtime-installer.ts";
import { saveShellRuntimePath } from "./shell-runtime-settings.ts";
import { type BashRuntimeDetails, validateBashRuntime } from "./shell-runtime-validator.ts";

export type RuntimeSetupComponent = "shell";

export function parseRuntimeSetupSelection(argv: readonly string[]): RuntimeSetupComponent[] | undefined {
  const argument = argv.find((value) => value.startsWith("--runtime-setup="));
  if (!argument) return undefined;
  const requested = argument.slice("--runtime-setup=".length).split(",").filter(Boolean);
  const selection: RuntimeSetupComponent[] = [];
  for (const component of requested) {
    if (component !== "shell") throw new Error(`Unsupported runtime setup component: ${component}`);
    if (!selection.includes(component)) selection.push(component);
  }
  if (selection.length === 0) throw new Error("Runtime setup requires at least one component");
  return selection;
}

export async function runRuntimeSetup(
  userDataDir: string,
  agentDir: string,
  selection: readonly RuntimeSetupComponent[],
): Promise<void> {
  mkdirSync(userDataDir, { recursive: true });
  const logPath = join(userDataDir, "runtime-setup.log");
  const log = (component: RuntimeSetupComponent, progress: ShellRuntimeProgress): void => {
    appendFileSync(logPath, `${new Date().toISOString()} ${component} ${JSON.stringify(progress)}\n`);
  };
  if (selection.includes("shell")) {
    const configured = await findConfiguredShellRuntime(userDataDir, agentDir);
    if (configured) {
      log("shell", {
        phase: "ready",
        percent: 100,
        message: `保留已配置的 Git Bash ${configured.version}`,
      });
    } else {
      const status = await new ShellRuntimeInstaller(userDataDir, (progress) => log("shell", progress)).install();
      if (!status.path) throw new Error("Git Bash 安装完成但未返回可执行文件路径");
      await saveShellRuntimePath(userDataDir, agentDir, status.path);
    }
  }
}

export async function findConfiguredShellRuntime(
  cwd: string,
  agentDir: string,
  validate: (path: string) => Promise<BashRuntimeDetails> = validateBashRuntime,
): Promise<BashRuntimeDetails | undefined> {
  const configuredPath = SettingsManager.create(cwd, agentDir).getShellPath();
  if (!configuredPath) return undefined;
  try {
    return await validate(configuredPath);
  } catch {
    return undefined;
  }
}
