import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "packages", "desktop");
const defaultOutputRoot = join(desktopRoot, "out", "sidecar");
const defaultPackagedRoot = join(desktopRoot, "output", "pi-sidecar");
const electronPath = require("electron");

export async function generateDesktopSidecarManifests(
  outputRoot = defaultOutputRoot,
  packagedRoot = defaultPackagedRoot,
) {
  const compatibility = runtimeCompatibility(electronPath);
  const protocolVersion = await sidecarProtocolVersion(outputRoot);
  writeManifest(outputRoot, {
    protocolVersion,
    entries: sidecarEntries("sidecar"),
    compatibility,
    integrity: runtimeIntegrity(outputRoot, ""),
  });
  writeManifest(packagedRoot, {
    protocolVersion,
    entries: sidecarEntries("../app.asar.unpacked/out/sidecar/sidecar"),
    compatibility,
    integrity: runtimeIntegrity(outputRoot, "../app.asar.unpacked/out/sidecar"),
  });
}

async function sidecarProtocolVersion(outputRoot) {
  const contractsPath = join(outputRoot, "shared", "sidecar-contracts.js");
  const contracts = await import(pathToFileURL(contractsPath).href);
  const protocolVersion = contracts.SIDECAR_PROTOCOL_VERSION;
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error(`Invalid compiled sidecar protocol version: ${String(protocolVersion)}`);
  }
  return protocolVersion;
}

function sidecarEntries(prefix) {
  return {
    thread: `${prefix}/thread-worker-main.js`,
    metadata: `${prefix}/metadata-worker-main.js`,
  };
}

function runtimeIntegrity(outputRoot, packagedPrefix) {
  const files = {};
  for (const entry of readdirSync(outputRoot, { recursive: true, encoding: "utf8" })) {
    const path = join(outputRoot, entry);
    if (!statSync(path).isFile() || entry === "runtime-manifest.json" || entry.endsWith(".map")) continue;
    files[packagedPrefix ? `${packagedPrefix}/${entry}` : entry] = fileHash(path);
  }
  return {
    entries: Object.fromEntries(
      Object.entries(sidecarEntries("sidecar")).map(([role, path]) => [role, fileHash(join(outputRoot, path))]),
    ),
    files,
  };
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runtimeCompatibility(executable) {
  const versions = JSON.parse(
    execFileSync(
      executable,
      [
        "-p",
        `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi ?? "unknown", platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch].filter((value) => value !== undefined).join(":") }); })()`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    ),
  );
  return {
    ...versions,
    runtimeCompatibilityId: createHash("sha256").update(JSON.stringify(versions)).digest("hex"),
  };
}

function writeManifest(root, manifest) {
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${relative(repoRoot, manifestPath)}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await generateDesktopSidecarManifests();
}
