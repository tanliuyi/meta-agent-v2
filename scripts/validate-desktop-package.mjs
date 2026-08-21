import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopSidecarSmokeEnvironment } from "./desktop-smoke-environment.mjs";
import { resolveElectronSidecarExecutable } from "./desktop-sidecar-executable.mjs";

export default async function validateDesktopPackage(context) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const manifestPath = join(resources, "pi-sidecar", "runtime-manifest.json");
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const executable = resolvePackagedExecutable(context);
  const isMac = context.electronPlatformName === "darwin" || context.electronPlatformName === "mas";
  const entries = Object.fromEntries(
    Object.entries(manifest.entries).map(([role, entry]) => [role, resolve(root, entry)]),
  );

  assertTargetRuntime(context, manifest);
  assertEmbeddedRuntimeManifest(resources, manifest);
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Packaged Electron executable is missing: ${executable}`);
  }
  const sidecarExecutable = resolveElectronSidecarExecutable(executable, {
    platform: isMac ? "darwin" : context.electronPlatformName,
    requireHelper: isMac,
  });
  if (isMac) assertHiddenMacSidecarHelper(sidecarExecutable);

  if (isMac) {
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
    execFileSync(sidecarExecutable, ["--check", entry], {
      stdio: "inherit",
      env: createDesktopSidecarSmokeEnvironment(process.env, sidecarExecutable),
    });
  }
  for (const [path, expectedHash] of Object.entries(manifest.integrity.files)) {
    assertHash(resolve(root, path), expectedHash, `Sidecar runtime file ${path}`);
  }

  const actualRuntime = JSON.parse(
    execFileSync(
      sidecarExecutable,
      [
        "-p",
        `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch].filter((value) => value !== undefined).join(":") }); })()`,
      ],
      { encoding: "utf8", env: createDesktopSidecarSmokeEnvironment(process.env, sidecarExecutable) },
    ),
  );
  for (const field of ["nodeVersion", "modulesAbi", "napi", "platform", "arch", "osRelease", "libc", "toolchain"]) {
    if (String(actualRuntime[field]) !== String(manifest.compatibility[field])) {
      throw new Error(
        `Packaged Electron ${field} mismatch: ${actualRuntime[field]} != ${manifest.compatibility[field]}`,
      );
    }
  }

  if (isMac) {
    execFileSync("otool", ["-L", sidecarExecutable], { stdio: "inherit" });
  } else if (context.electronPlatformName === "linux") {
    const libraries = execFileSync("ldd", [executable], { encoding: "utf8" });
    if (libraries.includes("not found")) throw new Error(`Packaged Electron has unresolved libraries:\n${libraries}`);
  }
  const agentDir = await mkdtemp(join(tmpdir(), "desktop-package-agent-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "desktop-package-user-data-"));
  try {
    await smokeMetadataWorker(sidecarExecutable, entries.metadata, manifest.compatibility, agentDir, userDataDir);
  } finally {
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ]);
  }
  console.log(`Validated packaged Electron embedded Node sidecar runtime at ${resources}`);
}

export function assertHiddenMacSidecarHelper(executable) {
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Packaged macOS Electron sidecar Helper is missing: ${executable}`);
  }
  if (process.platform !== "win32" && (statSync(executable).mode & 0o111) === 0) {
    throw new Error(`Packaged macOS Electron sidecar Helper is not executable: ${executable}`);
  }
  const infoPlist = join(dirname(dirname(executable)), "Info.plist");
  if (!existsSync(infoPlist) || !statSync(infoPlist).isFile()) {
    throw new Error(`Packaged macOS Electron sidecar Helper Info.plist is missing: ${infoPlist}`);
  }
  const contents = readFileSync(infoPlist, "utf8");
  if (!/<key>LSUIElement<\/key>\s*<true\s*\/>/.test(contents)) {
    throw new Error(`Packaged macOS Electron sidecar Helper does not set LSUIElement=true: ${infoPlist}`);
  }
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


function assertHash(path, expectedHash, description) {
  if (!expectedHash) return;
  const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${description} integrity mismatch: expected ${expectedHash}, got ${actualHash}`);
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
      protocolVersion: 4,
      workerInstanceId,
      expectedRuntime: compatibility,
      binding: { role: "metadata", value: { agentDir, userDataDir } },
    });
  });
  try {
    await ready;
    worker.send({ kind: "shutdown", protocolVersion: 4, workerInstanceId });
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
