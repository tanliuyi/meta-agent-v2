import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputRoot = join(repoRoot, "packages", "desktop", "out", "sidecar");

export function cleanDesktopSidecarOutput(outputRoot = defaultOutputRoot) {
  rmSync(outputRoot, { recursive: true, force: true });
}

export function synchronizeDesktopSidecarOutput(stagedRoot, outputRoot = defaultOutputRoot) {
  const stagedFiles = listFiles(stagedRoot);
  const desiredFiles = new Set(stagedFiles);
  const manifestPath = "runtime-manifest.json";
  const orderedFiles = stagedFiles
    .filter((path) => path !== manifestPath)
    .toSorted((left, right) => replacementPriority(left) - replacementPriority(right));

  for (const path of orderedFiles) atomicCopy(join(stagedRoot, path), join(outputRoot, path));
  for (const path of listFiles(outputRoot)) {
    if (path !== manifestPath && !desiredFiles.has(path)) rmSync(join(outputRoot, path), { force: true });
  }
  removeEmptyDirectories(outputRoot, outputRoot);
  if (desiredFiles.has(manifestPath)) atomicCopy(join(stagedRoot, manifestPath), join(outputRoot, manifestPath));
}

function listFiles(root, directory = root) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });
}

function replacementPriority(path) {
  if (/[\\/]sidecar[\\/](?:thread|metadata|subagent)-worker-main\.js$/.test(path)) return 1;
  return 0;
}

function atomicCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.next-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(source, temporaryPath);
    renameWithRetries(temporaryPath, destination);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function renameWithRetries(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 20 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "EACCES" && error.code !== "EPERM")
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function removeEmptyDirectories(root, directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(root, join(directory, entry.name));
  }
  if (directory !== root && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cleanDesktopSidecarOutput();
}
