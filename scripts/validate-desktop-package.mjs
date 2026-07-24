import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopSmokeEnvironment } from "./desktop-smoke-environment.mjs";

export default async function validateDesktopPackage(context) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const manifestPath = join(resources, "pi-sidecar", "runtime-manifest.json");
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const usesSystemNode = manifest.nodePath === "system";
  const nodePath = usesSystemNode ? resolve(process.env.PI_DESKTOP_NODE_EXEC_PATH ?? process.execPath) : resolve(root, manifest.nodePath);
  const npmCliPath = manifest.npmCliPath ? resolve(root, manifest.npmCliPath) : undefined;
  const entries = Object.fromEntries(
    Object.entries(manifest.entries).map(([role, entry]) => [role, resolve(root, entry)]),
  );

  assertTargetRuntime(context, manifest);
  validateHermesMemorySqliteRuntime(nodePath);

  if (context.electronPlatformName === "darwin") {
    const spawnHelper = join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${manifest.compatibility.arch}`,
      "spawn-helper",
    );
    if (!existsSync(spawnHelper) || !statSync(spawnHelper).isFile()) {
      throw new Error(`node-pty spawn-helper is missing from package: ${spawnHelper}`);
    }
    if ((statSync(spawnHelper).mode & 0o111) === 0) {
      throw new Error(`node-pty spawn-helper is not executable: ${spawnHelper}`);
    }
  }

  for (const [description, path, expectedHash] of [
    ["Node executable", nodePath, usesSystemNode ? "" : manifest.integrity.nodePath],
    ...(npmCliPath ? [["npm CLI", npmCliPath, manifest.integrity.npmCliPath]] : []),
  ]) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${description} is missing from package: ${path}`);
    if (/[\\/]app\.asar(?:[\\/]|$)/i.test(path)) throw new Error(`${description} is inside app.asar`);
    assertHash(path, expectedHash, description);
  }
  for (const [role, entry] of Object.entries(entries)) {
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`Sidecar entry is missing: ${entry}`);
    if (!entry.includes("app.asar.unpacked")) throw new Error(`Sidecar entry is not unpacked: ${entry}`);
    assertHash(entry, manifest.integrity.entries[role], `${role} sidecar entry`);
    execFileSync(nodePath, ["--check", entry], { stdio: "inherit" });
  }
  for (const [path, expectedHash] of Object.entries(manifest.integrity.files)) {
    assertHash(resolve(root, path), expectedHash, `Sidecar runtime file ${path}`);
  }

  const actualRuntime = JSON.parse(
    execFileSync(
      nodePath,
      [
        "-p",
        `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch, variables.clang].filter((value) => value !== undefined).join(":") }); })()`,
      ],
      { encoding: "utf8", env: withoutElectronRunAsNode() },
    ),
  );
  for (const field of ["nodeVersion", "modulesAbi", "napi", "platform", "arch", "osRelease", "libc", "toolchain"]) {
    if (String(actualRuntime[field]) !== String(manifest.compatibility[field])) {
      throw new Error(`Packaged Node ${field} mismatch: ${actualRuntime[field]} != ${manifest.compatibility[field]}`);
    }
  }

  if (context.electronPlatformName === "darwin") {
    execFileSync("otool", ["-L", nodePath], { stdio: "inherit" });
  } else if (context.electronPlatformName === "win32") {
    if (!usesSystemNode) throw new Error("Windows bundled Node is no longer supported; use the configured system Node");
  } else if (context.electronPlatformName === "linux") {
    const libraries = execFileSync("ldd", [nodePath], { encoding: "utf8" });
    if (libraries.includes("not found")) throw new Error(`Packaged Node has unresolved libraries:\n${libraries}`);
  }
  const agentDir = await mkdtemp(join(tmpdir(), "desktop-package-agent-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "desktop-package-user-data-"));
  try {
    await smokeSubagentWorker(nodePath, entries.subagent, manifest.compatibility, agentDir);
    await smokeMetadataWorker(nodePath, entries.metadata, manifest.compatibility, agentDir, userDataDir);
  } finally {
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ]);
  }
  console.log(`Validated packaged ordinary Node sidecar runtime at ${resources}`);
}

/**
 * The runtime is selected before electron-builder starts.  Reject a package
 * when the selected runtime describes a different target than the one being
 * assembled; otherwise a cross-target build can produce a seemingly valid
 * artifact containing a host-platform Node executable.
 */
export function assertTargetRuntime(context, manifest) {
  const platform = {
    darwin: "darwin",
    mas: "darwin",
    win32: "win32",
    linux: "linux",
  }[context.electronPlatformName];
  if (!platform) {
    throw new Error(`Unsupported Desktop package platform: ${context.electronPlatformName}`);
  }

  const architecture =
    typeof context.arch === "string" ? context.arch : ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  if (!architecture) {
    throw new Error(`Unsupported Desktop package architecture: ${String(context.arch)}`);
  }
  if (architecture === "universal") {
    throw new Error("Universal Desktop packaging requires per-architecture sidecar runtimes and is not supported by this package script");
  }

  const compatibility = manifest?.compatibility;
  if (compatibility?.platform !== platform || compatibility?.arch !== architecture) {
    throw new Error(
      `Desktop sidecar runtime target mismatch: package=${platform}/${architecture}, ` +
        `runtime=${String(compatibility?.platform)}/${String(compatibility?.arch)}`,
    );
  }
}

function validateHermesMemorySqliteRuntime(nodePath) {
  execFileSync(
    nodePath,
    [
      "-e",
      "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('SELECT 1');db.close();",
    ],
    { stdio: "inherit", env: withoutElectronRunAsNode() },
  );
}


function assertHash(path, expectedHash, description) {
  if (!expectedHash) return;
  const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${description} integrity mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
}

function withoutElectronRunAsNode() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "ELECTRON_RUN_AS_NODE"));
}

async function smokeSubagentWorker(nodePath, entry, compatibility, agentDir) {
  const worker = fork(entry, [], {
    execPath: nodePath,
    env: createDesktopSmokeEnvironment(process.env, nodePath, {
      PI_DESKTOP_RUNTIME_COMPATIBILITY_ID: compatibility.runtimeCompatibilityId,
    }),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
  });
  let stderr = "";
  worker.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const workerInstanceId = `package-subagent-smoke-${process.pid}`;
  const requestId = `ping-${process.pid}`;
  const result = new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(
      () => rejectResult(new Error(`Packaged subagent sidecar smoke timed out${stderr ? `\n${stderr}` : ""}`)),
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
        rejectResult(new Error(`Packaged subagent sidecar ping failed${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolveResult();
    });
    worker.once("error", rejectResult);
    worker.once("exit", (code, signal) =>
      rejectResult(new Error(`Packaged subagent sidecar exited (${code ?? signal ?? "unknown"})${stderr ? `\n${stderr}` : ""}`)),
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
          projectId: "package-smoke-project",
          parentThreadId: "package-smoke-thread",
          runId: "package-smoke-run",
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

async function smokeMetadataWorker(nodePath, entry, compatibility, agentDir, userDataDir) {
  const worker = fork(entry, [], {
    execPath: nodePath,
    env: createDesktopSmokeEnvironment(process.env, nodePath, {
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
  const workerInstanceId = randomUUID();
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`Packaged metadata sidecar handshake timed out${stderr ? `\n${stderr}` : ""}`)),
      15_000,
    );
    worker.on("message", (message) => {
      if (message?.kind !== "ready") return;
      clearTimeout(timer);
      if (message.workerInstanceId !== workerInstanceId) {
        rejectReady(new Error("Packaged metadata sidecar returned the wrong worker generation"));
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
          rejectReady(new Error(`Packaged metadata sidecar ${field} mismatch: ${message.runtime?.[field]} != ${compatibility[field]}`));
          return;
        }
      }
      resolveReady();
    });
    worker.once("error", rejectReady);
    worker.once("exit", (code, signal) =>
      rejectReady(new Error(`Packaged metadata sidecar exited (${code ?? signal ?? "unknown"})`)),
    );
  });
  worker.once("spawn", () => {
    worker.send({
      kind: "initialize",
      protocolVersion: 3,
      workerInstanceId,
      expectedRuntime: compatibility,
      binding: { role: "metadata", value: { agentDir, userDataDir } },
    });
  });
  try {
    await ready;
    worker.send({ kind: "shutdown", protocolVersion: 3, workerInstanceId });
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
      rejectExit(new Error(`Packaged sidecar did not exit after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    worker.once("exit", onExit);
  });
}
