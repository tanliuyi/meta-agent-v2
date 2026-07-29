import { createHash } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopSidecarSmokeEnvironment } from "./desktop-smoke-environment.mjs";
import { locateDesktopExecutable } from "./smoke-desktop-gui.mjs";
import { assertEmbeddedRuntimeManifest } from "./validate-desktop-package.mjs";

const artifact = parseArtifact(process.argv.slice(2));
const manifestPath = findManifest(artifact);
const root = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const executable = locateDesktopExecutable(artifact);
const resources = dirname(root);

assertEmbeddedRuntimeManifest(resources, manifest);
for (const [role, relativeEntry] of Object.entries(manifest.entries)) {
  const entry = resolve(root, relativeEntry);
  assertFile(entry, manifest.integrity.entries[role], `${role} sidecar entry`);
  if (/[\\/]app\.asar(?:[\\/]|$)/i.test(entry)) throw new Error(`${role} sidecar entry is inside app.asar`);
  execFileSync(executable, ["--check", entry], {
    stdio: "inherit",
    env: createDesktopSidecarSmokeEnvironment(process.env, executable),
  });
}
for (const [relativePath, expectedHash] of Object.entries(manifest.integrity.files ?? {})) {
  assertFile(resolve(root, relativePath), expectedHash, `sidecar runtime file ${relativePath}`);
}

const actualVersion = execFileSync(executable, ["--version"], {
  encoding: "utf8",
  env: createDesktopSidecarSmokeEnvironment(process.env, executable),
}).trim();
if (actualVersion !== manifest.compatibility.nodeVersion) {
  throw new Error(`Embedded Electron Node version mismatch: ${actualVersion} != ${manifest.compatibility.nodeVersion}`);
}
const actualAbi = JSON.parse(
  execFileSync(
    executable,
    [
      "-p",
      `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi ?? "unknown", platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch].filter((value) => value !== undefined).join(":") }); })()`,
    ],
    { encoding: "utf8", env: createDesktopSidecarSmokeEnvironment(process.env, executable) },
  ),
);
for (const field of ["nodeVersion", "modulesAbi", "napi", "platform", "arch", "osRelease", "libc", "toolchain"]) {
  if (String(actualAbi[field]) !== String(manifest.compatibility[field])) {
    throw new Error(`Embedded Electron Node ${field} mismatch: ${actualAbi[field]} != ${manifest.compatibility[field]}`);
  }
}

const agentDir = process.env.PI_CODING_AGENT_DIR ?? (await mkdtemp(join(tmpdir(), "desktop-sidecar-agent-")));
const userDataDir = await mkdtemp(join(tmpdir(), "desktop-sidecar-user-data-"));
try {
  await smokeSubagentWorker(
    executable,
    resolve(root, manifest.entries.subagent),
    manifest.compatibility,
    agentDir,
  );
  await smokeMetadataWorker(executable, resolve(root, manifest.entries.metadata), manifest.compatibility, agentDir, userDataDir);
} finally {
  if (!process.env.PI_CODING_AGENT_DIR) await rm(agentDir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
console.log(`Desktop sidecar smoke passed: ${manifestPath}`);

function parseArtifact(args) {
  const index = args.indexOf("--artifact");
  if (index === -1 || !args[index + 1]) throw new Error("Usage: npm run smoke:sidecar -- --artifact <path>");
  return resolve(process.env.INIT_CWD ?? process.cwd(), args[index + 1]);
}

function findManifest(path) {
  const candidates = [
    join(path, "runtime-manifest.json"),
    join(path, "pi-sidecar", "runtime-manifest.json"),
    join(path, "resources", "pi-sidecar", "runtime-manifest.json"),
    join(path, "Contents", "Resources", "pi-sidecar", "runtime-manifest.json"),
  ];
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const entry of readdirSafe(path)) {
      candidates.push(join(path, entry, "Contents", "Resources", "pi-sidecar", "runtime-manifest.json"));
    }
  }
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`Cannot find pi-sidecar/runtime-manifest.json under ${path}`);
  return match;
}

function readdirSafe(path) {
  try {
    return readdirSync(path, { encoding: "utf8" });
  } catch {
    return [];
  }
}

function assertFile(path, expectedHash, description) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${description} is missing: ${path}`);
  const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (expectedHash && actualHash !== expectedHash) throw new Error(`${description} integrity mismatch: ${path}`);
}

async function smokeSubagentWorker(executable, entry, compatibility, agentDir) {
  const worker = fork(entry, [], {
    execPath: executable,
    env: createDesktopSidecarSmokeEnvironment(process.env, executable, {
      PI_DESKTOP_RUNTIME_COMPATIBILITY_ID: compatibility.runtimeCompatibilityId,
    }),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
  });
  let stderr = "";
  worker.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const workerInstanceId = `subagent-smoke-${process.pid}`;
  const requestId = `ping-${process.pid}`;
  const result = new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(
      () => rejectResult(new Error(`subagent sidecar smoke timed out${stderr ? `\n${stderr}` : ""}`)),
      15_000,
    );
    worker.on("message", (message) => {
      if (message?.workerInstanceId !== workerInstanceId) return;
      if (message.kind === "ready") {
        worker.send({
          kind: "request",
          protocolVersion: 3,
          workerInstanceId,
          requestId,
          command: { type: "ping" },
        });
        return;
      }
      if (message.kind !== "response" || message.requestId !== requestId) return;
      clearTimeout(timer);
      if (!message.ok || message.result?.pong !== true) {
        rejectResult(new Error(`subagent sidecar ping failed${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolveResult();
    });
    worker.once("error", rejectResult);
    worker.once("exit", (code, signal) =>
      rejectResult(new Error(`subagent sidecar exited (${code ?? signal ?? "unknown"})${stderr ? `\n${stderr}` : ""}`)),
    );
  });
  worker.once("spawn", () => {
    worker.send({
      kind: "initialize",
      protocolVersion: 3,
      workerInstanceId,
      expectedRuntime: compatibility,
      binding: {
        role: "subagent",
        value: {
          projectId: "smoke-project",
          parentThreadId: "smoke-thread",
          runId: "smoke-run",
          childIndex: 0,
          agentDir,
        },
      },
    });
  });
  try {
    await result;
    worker.send({ kind: "shutdown", protocolVersion: 3, workerInstanceId });
    await waitForExit(worker, 10_000);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }
}

async function smokeMetadataWorker(executable, entry, compatibility, agentDir, userDataDir) {
  const worker = fork(entry, [], {
    execPath: executable,
    env: createDesktopSidecarSmokeEnvironment(process.env, executable, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_RUNTIME_COMPATIBILITY_ID: compatibility.runtimeCompatibilityId,
    }),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
  });
  let stderr = "";
  worker.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const workerInstanceId = `smoke-${process.pid}`;
  const protocolVersion = 3;
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`metadata sidecar handshake timed out${stderr ? `\n${stderr}` : ""}`)), 15_000);
    worker.on("message", (message) => {
      if (message?.kind !== "ready") return;
      clearTimeout(timer);
      if (message.workerInstanceId !== workerInstanceId) {
        rejectReady(new Error("metadata sidecar returned the wrong worker generation"));
        return;
      }
      for (const field of [
        "nodeVersion",
        "modulesAbi",
        "napi",
        "platform",
        "arch",
        "osRelease",
        "libc",
        "toolchain",
        "piVersion",
        "runtimeCompatibilityId",
      ]) {
        if (String(message.runtime?.[field]) !== String(compatibility[field])) {
          rejectReady(new Error(`metadata sidecar ${field} mismatch: ${message.runtime?.[field]} != ${compatibility[field]}`));
          return;
        }
      }
      resolveReady();
    });
    worker.once("error", rejectReady);
    worker.once("exit", (code, signal) =>
      rejectReady(new Error(`metadata sidecar exited (${code ?? signal ?? "unknown"})${stderr ? `\n${stderr}` : ""}`)),
    );
  });
  worker.once("spawn", () => {
    worker.send({
      kind: "initialize",
      protocolVersion,
      workerInstanceId,
      expectedRuntime: compatibility,
      binding: { role: "metadata", value: { agentDir, userDataDir } },
    });
  });
  try {
    await ready;
    worker.send({ kind: "shutdown", protocolVersion, workerInstanceId });
    await waitForExit(worker, 10_000);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }
}

function waitForExit(worker, timeoutMs) {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      worker.removeListener("exit", onExit);
      rejectExit(new Error(`sidecar did not exit after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    worker.once("exit", onExit);
  });
}
