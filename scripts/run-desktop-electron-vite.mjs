import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (command !== "dev" && command !== "preview") {
  throw new Error("Usage: node scripts/run-desktop-electron-vite.mjs <dev|preview> [arguments]");
}

const packagePath = fileURLToPath(import.meta.resolve("electron-vite/package.json"));
const cliPath = join(dirname(packagePath), "bin", "electron-vite.js");
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cliPath, command, ...args], {
  env: environment,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Failed to start electron-vite: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
