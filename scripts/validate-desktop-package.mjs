import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopSidecarSmokeEnvironment } from "./desktop-smoke-environment.mjs";

export default async function validateDesktopPackage(context) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const manifestPath = join(resources, "pi-sidecar", "runtime-manifest.json");
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const executable = resolvePackagedExecutable(context);
  const entries = Object.fromEntries(
    Object.entries(manifest.entries).map(([role, entry]) => [role, resolve(root, entry)]),
  );

  assertTargetRuntime(context, manifest);
  assertEmbeddedRuntimeManifest(resources, manifest);
  assertBundledPiDocumentation(resources);
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Packaged Electron executable is missing: ${executable}`);
  }
  validateHermesMemorySqliteRuntime(executable);

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

  for (const [role, entry] of Object.entries(entries)) {
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`Sidecar entry is missing: ${entry}`);
    if (!entry.includes("app.asar.unpacked")) throw new Error(`Sidecar entry is not unpacked: ${entry}`);
    assertHash(entry, manifest.integrity.entries[role], `${role} sidecar entry`);
    execFileSync(executable, ["--check", entry], {
      stdio: "inherit",
      env: createDesktopSidecarSmokeEnvironment(process.env, executable),
    });
  }
  for (const [path, expectedHash] of Object.entries(manifest.integrity.files)) {
    assertHash(resolve(root, path), expectedHash, `Sidecar runtime file ${path}`);
  }

  const actualRuntime = JSON.parse(
    execFileSync(
      executable,
      [
        "-p",
        `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch].filter((value) => value !== undefined).join(":") }); })()`,
      ],
      { encoding: "utf8", env: createDesktopSidecarSmokeEnvironment(process.env, executable) },
    ),
  );
  for (const field of ["nodeVersion", "modulesAbi", "napi", "platform", "arch", "osRelease", "libc", "toolchain"]) {
    if (String(actualRuntime[field]) !== String(manifest.compatibility[field])) {
      throw new Error(
        `Packaged Electron ${field} mismatch: ${actualRuntime[field]} != ${manifest.compatibility[field]}`,
      );
    }
  }

  if (context.electronPlatformName === "darwin") {
    execFileSync("otool", ["-L", executable], { stdio: "inherit" });
  } else if (context.electronPlatformName === "linux") {
    const libraries = execFileSync("ldd", [executable], { encoding: "utf8" });
    if (libraries.includes("not found")) throw new Error(`Packaged Electron has unresolved libraries:\n${libraries}`);
  }
  const agentDir = await mkdtemp(join(tmpdir(), "desktop-package-agent-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "desktop-package-user-data-"));
  try {
    await smokeSubagentWorker(executable, entries.subagent, manifest.compatibility, agentDir);
    await smokeMetadataWorker(executable, entries.metadata, manifest.compatibility, agentDir, userDataDir);
  } finally {
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ]);
  }
  console.log(`Validated packaged Electron embedded Node sidecar runtime at ${resources}`);
}

export function resolvePackagedExecutable(context) {
  const productFilename = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === "darwin") {
    return join(context.appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename);
  }
  const executableName = context.packager.executableName ?? productFilename;
  return join(context.appOutDir, context.electronPlatformName === "win32" ? `${executableName}.exe` : executableName);
}

export function assertEmbeddedRuntimeManifest(resources, manifest) {
  if ("nodePath" in manifest || "npmCliPath" in manifest) {
    throw new Error("Packaged sidecar manifest contains legacy external Node fields");
  }
  if ("nodePath" in (manifest.integrity ?? {}) || "npmCliPath" in (manifest.integrity ?? {})) {
    throw new Error("Packaged sidecar manifest contains legacy external Node integrity fields");
  }
  for (const path of [
    join(resources, "node-runtime"),
    join(resources, "app.asar.unpacked", "node-runtime"),
    join(dirname(resources), "node-runtime"),
  ]) {
    if (existsSync(path)) throw new Error(`Packaged Desktop contains an external Node runtime: ${path}`);
  }
}

/** Reject cross-target packages because the manifest is generated from the installed Electron binary. */
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

export function assertBundledPiDocumentation(resources) {
  const packageRoot = join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  for (const relativePath of [
    "README.md",
    "docs/extensions.md",
    "docs/sdk.md",
    "examples/extensions/README.md",
    "examples/sdk/01-minimal.ts",
  ]) {
    const path = join(packageRoot, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Bundled Pi documentation is missing from package: ${path}`);
    }
  }
}

function validateHermesMemorySqliteRuntime(executable) {
  execFileSync(
    executable,
    [
      "-e",
      "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('SELECT 1');db.close();",
    ],
    { stdio: "inherit", env: createDesktopSidecarSmokeEnvironment(process.env, executable) },
  );
}


function assertHash(path, expectedHash, description) {
  if (!expectedHash) return;
  const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${description} integrity mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
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
