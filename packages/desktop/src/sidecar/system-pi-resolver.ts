import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export interface SystemPiInvocation {
  command: string;
  argsPrefix: string[];
  executablePath: string;
  packageRoot?: string;
}

export interface ProbedSystemPi extends SystemPiInvocation {
  version: string;
}

interface PiPackageJson {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

function pathValue(environment: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === "path");
  return key ? environment[key] : undefined;
}

function pathEntries(environment: NodeJS.ProcessEnv): string[] {
  return (pathValue(environment) ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutable(filePath: string): boolean {
  if (!isFile(filePath)) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative))
  );
}

function readPiPackage(packageRoot: string): { cliPath: string; version: string } | undefined {
  try {
    const canonicalRoot = realpathSync(packageRoot);
    const packageJsonPath = join(canonicalRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PiPackageJson;
    if (packageJson.name !== PI_PACKAGE_NAME || typeof packageJson.version !== "string") return undefined;

    const bin = packageJson.bin;
    const binPath =
      typeof bin === "string"
        ? bin
        : typeof bin === "object" && bin !== null && "pi" in bin && typeof bin.pi === "string"
          ? bin.pi
          : undefined;
    if (!binPath) return undefined;

    const cliPath = realpathSync(resolve(canonicalRoot, binPath));
    if (!isWithin(canonicalRoot, cliPath) || !isFile(cliPath) || ![".js", ".cjs", ".mjs"].includes(extname(cliPath))) {
      return undefined;
    }
    return { cliPath, version: packageJson.version };
  } catch {
    return undefined;
  }
}

function resolveWindowsShim(shimPath: string, entries: readonly string[]): SystemPiInvocation | undefined {
  const shimDirectory = realpathSync(dirname(shimPath));
  const siblingNodePath = join(shimDirectory, "node.exe");
  const nodePath = isFile(siblingNodePath)
    ? siblingNodePath
    : entries.map((entry) => join(entry, "node.exe")).find(isFile);
  const packageRoot = join(shimDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!nodePath) return undefined;

  const resolvedPackage = readPiPackage(packageRoot);
  if (!resolvedPackage) return undefined;
  return {
    command: realpathSync(nodePath),
    argsPrefix: [resolvedPackage.cliPath],
    executablePath: realpathSync(shimPath),
    packageRoot: realpathSync(packageRoot),
  };
}

export function resolveSystemPi(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SystemPiInvocation {
  const entries = pathEntries(environment);
  if (platform === "win32") {
    for (const directory of entries) {
      const executable = join(directory, "pi.exe");
      if (isFile(executable)) {
        const canonical = realpathSync(executable);
        return { command: canonical, argsPrefix: [], executablePath: canonical };
      }
      const shim = join(directory, "pi.cmd");
      if (isFile(shim)) {
        const invocation = resolveWindowsShim(shim, entries);
        if (invocation) return invocation;
      }
    }
  } else {
    for (const directory of entries) {
      const executable = join(directory, "pi");
      if (!isExecutable(executable)) continue;
      const canonical = realpathSync(executable);
      return { command: canonical, argsPrefix: [], executablePath: canonical };
    }
  }

  throw new Error("Unable to find a runnable system Pi CLI in PATH");
}

function appendBounded(current: string, chunk: Buffer, label: string): string {
  if (Buffer.byteLength(current) + chunk.byteLength > MAX_VERSION_OUTPUT_BYTES) {
    throw new Error(`System Pi ${label} exceeded ${MAX_VERSION_OUTPUT_BYTES} bytes`);
  }
  return current + chunk.toString("utf8");
}

export async function probeSystemPi(
  invocation: SystemPiInvocation,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProbedSystemPi> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, "--version"], {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectProbe(error);
      else {
        const version = stdout.trim();
        if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
          rejectProbe(new Error(`System Pi returned an invalid version: ${JSON.stringify(version)}`));
          return;
        }
        resolveProbe({ ...invocation, version });
      }
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`System Pi version probe timed out after ${VERSION_TIMEOUT_MS}ms`));
    }, VERSION_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (error) => finish(new Error(`Unable to start system Pi: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdout = appendBounded(stdout, chunk, "version output");
      } catch (error) {
        child.kill("SIGKILL");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = appendBounded(stderr, chunk, "version stderr");
      } catch (error) {
        child.kill("SIGKILL");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `System Pi version probe failed (code=${code ?? "null"}, signal=${signal ?? "none"}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      finish();
    });
  });
}

export async function resolveAndProbeSystemPi(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ProbedSystemPi> {
  return probeSystemPi(resolveSystemPi(environment, platform), environment);
}
