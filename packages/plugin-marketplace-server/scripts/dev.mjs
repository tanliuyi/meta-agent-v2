import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), "watch", "src/main.ts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
