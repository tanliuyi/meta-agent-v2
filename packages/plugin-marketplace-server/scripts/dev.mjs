import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = {
  ...process.env,
  MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
};
delete env.MARKETPLACE_SIGNING_PRIVATE_KEY;

const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), "watch", "src/main.ts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
