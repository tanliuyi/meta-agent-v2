import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NodeRuntimeProgress } from "../../shared/desktop-api.ts";
import { NodeRuntimeInstaller } from "./node-runtime-installer.ts";
import { ShellRuntimeInstaller } from "./shell-runtime-installer.ts";

export type RuntimeSetupComponent = "node" | "shell";

export function parseRuntimeSetupSelection(argv: readonly string[]): RuntimeSetupComponent[] | undefined {
  const argument = argv.find((value) => value.startsWith("--runtime-setup="));
  if (!argument) return undefined;
  const requested = argument.slice("--runtime-setup=".length).split(",").filter(Boolean);
  const selection: RuntimeSetupComponent[] = [];
  for (const component of requested) {
    if (component !== "node" && component !== "shell")
      throw new Error(`Unsupported runtime setup component: ${component}`);
    if (!selection.includes(component)) selection.push(component);
  }
  if (selection.length === 0) throw new Error("Runtime setup requires at least one component");
  return selection;
}

export async function runRuntimeSetup(userDataDir: string, selection: readonly RuntimeSetupComponent[]): Promise<void> {
  mkdirSync(userDataDir, { recursive: true });
  const logPath = join(userDataDir, "runtime-setup.log");
  const log = (component: RuntimeSetupComponent, progress: NodeRuntimeProgress): void => {
    appendFileSync(logPath, `${new Date().toISOString()} ${component} ${JSON.stringify(progress)}\n`);
  };
  if (selection.includes("node"))
    await new NodeRuntimeInstaller(userDataDir, (progress) => log("node", progress)).install();
  if (selection.includes("shell")) {
    await new ShellRuntimeInstaller(userDataDir, (progress) => log("shell", progress)).install();
  }
}
