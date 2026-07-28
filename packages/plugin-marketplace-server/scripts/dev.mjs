import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = {
  ...process.env,
  MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY: "true",
};
delete env.MARKETPLACE_SIGNING_PRIVATE_KEY;

// Load .env file if it exists
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  // Use process.loadEnvFile if available (Node 21.7+)
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
      Object.assign(env, process.env);
      // Re-apply our override after loadEnvFile
      env.MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY = "true";
      delete env.MARKETPLACE_SIGNING_PRIVATE_KEY;
    } catch {
      // Fallback to manual parsing below
    }
  }
}

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
