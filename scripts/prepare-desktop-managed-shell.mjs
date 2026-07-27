import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const release = "v2.53.0.windows.3";
const assets = {
  x64: {
    name: "PortableGit-2.53.0.3-64-bit.7z.exe",
    sha256: "b365da794b1d2225eb24d5f5e09ef7792cfd5fa26c3a3586210280c80dff3a2a",
  },
  arm64: {
    name: "PortableGit-2.53.0.3-arm64.7z.exe",
    sha256: "0db54010054c01f35501cf69e1e32d3710138ecb934d188bd77093afed24300e",
  },
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputRoot = join(repoRoot, "packages", "desktop", "output", "managed-shell");
const defaultDownloadRoot = join(repoRoot, "packages", "desktop", "output", "downloads");

export async function prepareDesktopManagedShell(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const arch = options.arch ?? process.env.npm_config_arch ?? process.arch;
  const asset = assets[arch];
  if (!asset) throw new Error(`Unsupported Windows managed shell architecture: ${arch}`);

  const outputRoot = options.outputRoot ?? defaultOutputRoot;
  const downloadRoot = options.downloadRoot ?? defaultDownloadRoot;
  const shellPath = join(outputRoot, "bin", "bash.exe");
  const url = `https://github.com/git-for-windows/git/releases/download/${release}/${asset.name}`;
  const manifest = {
    runtime: "PortableGit",
    release,
    arch,
    asset: asset.name,
    sha256: asset.sha256,
    source: `https://github.com/git-for-windows/git/tree/${release}`,
    download: url,
    licenses: ["mingw64/share/licenses", "usr/share/licenses"],
  };

  await mkdir(downloadRoot, { recursive: true });
  const archivePath = join(downloadRoot, asset.name);
  if (!existsSync(archivePath) || (await hashFile(archivePath)) !== asset.sha256) {
    await download(url, archivePath);
  }
  const actualHash = await hashFile(archivePath);
  if (actualHash !== asset.sha256) {
    throw new Error(`PortableGit archive integrity mismatch: expected ${asset.sha256}, got ${actualHash}`);
  }

  const temporaryRoot = `${outputRoot}.tmp-${process.pid}`;
  rmSync(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
  try {
    expandArchive(archivePath, temporaryRoot);
    if (!existsSync(join(temporaryRoot, "bin", "bash.exe"))) {
      throw new Error("PortableGit archive does not contain bin/bash.exe");
    }
    await writeFile(join(temporaryRoot, "META_AGENT_MANAGED_SHELL.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(outputRoot, { recursive: true, force: true });
    renameSync(temporaryRoot, outputRoot);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return shellPath;
}

async function download(url, destination) {
  let lastError = new Error("PortableGit download failed");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryPath = `${destination}.tmp-${process.pid}`;
    rmSync(temporaryPath, { force: true });
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`PortableGit download failed with HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
      rmSync(destination, { force: true });
      renameSync(temporaryPath, destination);
      return;
    } catch (error) {
      lastError = error;
      rmSync(temporaryPath, { force: true });
      if (attempt < 3) await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 1_000));
    }
  }
  throw lastError;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function expandArchive(archivePath, destination) {
  const result = spawnSync(archivePath, ["-y", `-o${destination}`], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Failed to extract PortableGit archive (exit ${result.status ?? "unknown"})`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const shellPath = await prepareDesktopManagedShell();
  console.log(shellPath ? `Prepared managed Bash at ${shellPath}` : "Managed Bash is only prepared on Windows");
}
