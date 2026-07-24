import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "packages", "desktop");
const outputRoot = join(desktopRoot, "out", "sidecar");
const packagedRoot = join(desktopRoot, "output", "pi-sidecar");
const codingAgentPackage = JSON.parse(readFileSync(join(repoRoot, "packages", "coding-agent", "package.json"), "utf8"));
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) throw new Error("npm_execpath is required to generate the Desktop sidecar runtime manifest");

const packagedNodePath = join(desktopRoot, "output", "node-runtime", process.platform === "win32" ? "node.exe" : "bin/node");
const hasBundledDevelopmentNode = false;
const developmentNodePath = process.env.PI_DESKTOP_NODE_EXEC_PATH ? resolve(process.env.PI_DESKTOP_NODE_EXEC_PATH) : process.execPath;
const developmentNpmPath = hasBundledDevelopmentNode
  ? join(desktopRoot, "output", "node-runtime", process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js")
  : resolve(npmCliPath);
writeManifest(outputRoot, {
  nodePath: developmentNodePath,
  npmCliPath: developmentNpmPath,
  entries: sidecarEntries("sidecar"),
  compatibility: runtimeCompatibility(developmentNodePath),
  integrity: runtimeIntegrity(
    developmentNodePath,
    developmentNpmPath,
    "",
  ),
});

writeManifest(packagedRoot, {
  nodePath: "system",
  npmCliPath: "",
  entries: sidecarEntries("../app.asar.unpacked/out/sidecar/sidecar"),
  compatibility: runtimeCompatibility(developmentNodePath),
  integrity: runtimeIntegrity(
    hasBundledDevelopmentNode ? packagedNodePath : "",
    "",
    "../app.asar.unpacked/out/sidecar",
  ),
});

function sidecarEntries(prefix) {
  return {
    thread: `${prefix}/thread-worker-main.js`,
    metadata: `${prefix}/metadata-worker-main.js`,
    subagent: `${prefix}/subagent-worker-main.js`,
  };
}

function runtimeIntegrity(nodePath, npmPath, packagedPrefix) {
  const files = {};
  for (const entry of readdirSync(outputRoot, { recursive: true, encoding: "utf8" })) {
    const path = join(outputRoot, entry);
    if (!statSync(path).isFile() || entry === "runtime-manifest.json" || entry.endsWith(".map")) continue;
    files[packagedPrefix ? `${packagedPrefix}/${entry}` : entry] = fileHash(path);
  }
  return {
    nodePath: nodePath ? fileHash(nodePath) : "",
    npmCliPath: npmPath ? fileHash(npmPath) : "",
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
        `(() => { const variables = process.config.variables; const osRelease = process.platform === "darwin" ? "darwin-23+" : process.platform === "win32" ? "windows-10+" : process.platform === "linux" ? "linux-kernel-4.18+" : "unsupported"; const libc = process.platform === "darwin" ? "libSystem" : process.platform === "win32" ? "ucrt" : process.platform === "linux" ? "glibc-2.28+" : "unknown"; return JSON.stringify({ nodeVersion: process.version, modulesAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, osRelease, libc, toolchain: [variables.host_arch, variables.target_arch, variables.v8_target_arch].filter((value) => value !== undefined).join(":") }); })()`,
      ],
      { encoding: "utf8" },
    ),
  );
  const compatibility = { ...versions, napi: versions.napi ?? "unknown", piVersion: codingAgentPackage.version };
  return {
    ...compatibility,
    runtimeCompatibilityId: createHash("sha256").update(JSON.stringify(compatibility)).digest("hex"),
  };
}

function writeManifest(root, manifest) {
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${relative(repoRoot, manifestPath)}`);
}
