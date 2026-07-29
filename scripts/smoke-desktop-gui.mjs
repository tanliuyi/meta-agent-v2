import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { extname, join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createDesktopGuiSmokeEnvironment } from "./desktop-smoke-environment.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const SMOKE_PROJECT_ID = "desktop-gui-smoke-project";

if (isMainModule()) {
  run().catch((error) => {
    console.error(`Desktop GUI smoke failed: ${formatError(error)}`);
    process.exitCode = 1;
  });
}

export async function run(options = parseArguments(process.argv.slice(2))) {
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.artifact) throw new Error(`Missing --artifact.\n\n${usage()}`);

  const executable = locateDesktopExecutable(options.artifact, process.platform);
  const modes = options.mode === "both" ? ["normal", "forced"] : [options.mode];
  const results = [];
  for (const mode of modes) {
    results.push(await runScenario(executable, mode, options));
  }

  for (const result of results) {
    const childSummary = result.sidecarCommand ? `; sidecar=${result.sidecarCommand}` : "";
    console.log(`Desktop GUI smoke ${result.mode} passed (${result.targetUrl}${childSummary})`);
  }
}

export function parseArguments(args) {
  const options = {
    artifact: undefined,
    help: false,
    keepTemp: false,
    mode: "both",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (argument === "--artifact" || argument === "--mode" || argument === "--timeout") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--artifact") options.artifact = resolveArtifact(value);
      else if (argument === "--mode") options.mode = value;
      else options.timeoutMs = parseTimeout(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["both", "normal", "forced"].includes(options.mode)) {
    throw new Error(`--mode must be one of both, normal, forced (received ${options.mode})`);
  }
  return options;
}

export function locateDesktopExecutable(input, platform = process.platform) {
  const artifact = resolve(input);
  if (!existsSync(artifact)) throw new Error(`Desktop artifact does not exist: ${artifact}`);
  const stats = statSync(artifact);
  if (stats.isFile()) {
    if (platform === "darwin" && artifact.endsWith(".app")) {
      return macAppExecutable(artifact);
    }
    if (!isLaunchableArtifactFile(artifact, platform)) {
      throw new Error(`Desktop artifact is not a launchable application: ${artifact}`);
    }
    return artifact;
  }

  if (platform === "darwin") {
    const appBundle = findMacAppBundle(artifact);
    if (!appBundle) {
      throw new Error(`Could not find a .app bundle under Desktop artifact: ${artifact}`);
    }
    return macAppExecutable(appBundle);
  }

  const executable = findExecutableUnderDirectory(artifact, platform);
  if (!executable) {
    throw new Error(`Could not find a launchable Desktop executable under: ${artifact}`);
  }
  return executable;
}

export function createMinimalGuiEnvironment(baseEnvironment, executable, paths) {
  return createDesktopGuiSmokeEnvironment(baseEnvironment, executable, {
    PI_CODING_AGENT_DIR: paths.agentDir,
  });
}

export function createGuiSmokeDesktopState(cwd, lastOpenedAt = Date.now()) {
  return {
    version: 1,
    activeProjectId: SMOKE_PROJECT_ID,
    projects: [
      {
        id: SMOKE_PROJECT_ID,
        name: "Desktop GUI smoke project",
        cwd,
        lastOpenedAt,
      },
    ],
    archivedThreads: {},
    workbenches: {},
  };
}

function usage() {
  return [
    "Usage: npm --prefix packages/desktop run smoke:gui -- --artifact <installed-app> [options]",
    "",
    "Options:",
    "  --artifact <path>  .app, AppImage, .exe, or unpacked installed app directory",
    "  --mode <mode>      both (default), normal, or forced",
    "  --timeout <ms>     GUI readiness timeout (default: 30000)",
    "  --keep-temp        preserve isolated user-data and agent directories",
    "  --help             show this help",
  ].join("\n");
}

function resolveArtifact(value) {
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

async function runScenario(executable, mode, options) {
  const root = await mkdtemp(join(tmpdir(), "Meta Agent GUI smoke 空格-"));
  const userDataDir = join(root, "用户 data with spaces");
  const agentDir = join(root, "agent data with spaces");
  const cwd = join(root, "working directory 非 ASCII");
  const paths = { agentDir, cwd, root, userDataDir };
  await Promise.all([ensureDirectory(userDataDir), ensureDirectory(agentDir), ensureDirectory(cwd)]);
  await writeFile(
    join(userDataDir, "desktop-state.json"),
    `${JSON.stringify(createGuiSmokeDesktopState(cwd), null, 2)}\n`,
    "utf8",
  );

  let child;
  let stderr = "";
  try {
    const port = await reservePort();
    const environment = createMinimalGuiEnvironment(process.env, executable, paths);
    child = spawn(
      executable,
      [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`],
      {
        cwd,
        detached: process.platform !== "win32",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.stdout?.resume();
    const initialChildren = await waitForSidecar(child, port, options.timeoutMs, () => stderr, executable);
    const targetUrl = initialChildren.targetUrl;
    const sidecarCommand = initialChildren.sidecarCommand;
    if (mode === "normal") {
      await terminateNormally(child, QUIT_TIMEOUT_MS);
    } else {
      terminateProcessTree(child, "SIGKILL");
      await waitForChildClose(child, QUIT_TIMEOUT_MS);
    }
    await assertNoOrphans(initialChildren.processes, QUIT_TIMEOUT_MS);
    return { mode, sidecarCommand, targetUrl };
  } catch (error) {
    if (child) {
      terminateProcessTree(child, "SIGKILL");
      await waitForChildClose(child, QUIT_TIMEOUT_MS).catch(() => undefined);
    }
    throw new Error(`${formatError(error)}${stderr ? `\nApplication stderr:\n${stderr}` : ""}`);
  } finally {
    if (!options.keepTemp) await rm(root, { recursive: true, force: true });
    else console.log(`Preserved GUI smoke temporary directory: ${root}`);
  }
}

async function waitForSidecar(child, port, timeoutMs, readStderr, expectedExecutable) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop application exited before GUI readiness (${child.exitCode ?? child.signalCode ?? "unknown"})` +
          (readStderr() ? `\nApplication stderr:\n${readStderr()}` : ""),
      );
    }
    let version;
    let targets;
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    } catch (error) {
      lastError = formatError(error);
      await delay(POLL_INTERVAL_MS);
      continue;
    }
    const readiness = inspectGuiSidecarReadiness(
      version,
      targets,
      snapshotProcessTree(child.pid),
      expectedExecutable,
    );
    if (readiness.status === "ready") return readiness.result;
    lastError = readiness.reason;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for packaged GUI readiness: ${lastError}`);
}

export function inspectGuiSidecarReadiness(version, targets, processes, expectedExecutable) {
  const target = Array.isArray(targets)
    ? targets.find((item) => item?.type === "page" && isDesktopTarget(item.url))
    : undefined;
  if (!version?.Browser || !target?.url) {
    return { status: "pending", reason: "DevTools endpoint is up but no renderer page is ready" };
  }

  const sidecar = processes.find((item) => /metadata-worker-main\.js/.test(item.command));
  if (!sidecar) {
    return { status: "pending", reason: "GUI became reachable but no Electron metadata sidecar was observed" };
  }
  if (/(?:^|[\\/])node(?:\.exe)?(?:\s|$)/i.test(sidecar.command) || /[\\/]node-runtime[\\/]/i.test(sidecar.command)) {
    throw new Error(`Metadata sidecar used an external Node runtime: ${sidecar.command}`);
  }
  if (/app\.asar[\\/]/i.test(sidecar.command) && !/app\.asar\.unpacked[\\/]/i.test(sidecar.command)) {
    throw new Error(`Metadata sidecar was launched from app.asar: ${sidecar.command}`);
  }
  if (!/app\.asar\.unpacked[\\/]/i.test(sidecar.command)) {
    throw new Error(`Metadata sidecar entry is not visibly unpacked: ${sidecar.command}`);
  }
  if (!sidecar.command.includes(expectedExecutable)) {
    throw new Error(`Metadata sidecar did not use the packaged Electron executable: ${sidecar.command}`);
  }
  if (/--type=(?:renderer|gpu-process)/.test(sidecar.command)) {
    throw new Error(`Metadata sidecar launched as an Electron GUI process: ${sidecar.command}`);
  }
  return {
    status: "ready",
    result: { processes, sidecarCommand: sidecar.command, targetUrl: target.url },
  };
}

function isDesktopTarget(url) {
  return typeof url === "string" && (url.startsWith("file:") || url.includes("app.asar"));
}

async function terminateNormally(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChildClose(child, timeoutMs);
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function snapshotProcessTree(rootPid) {
  if (!rootPid) return [];
  const processes = snapshotProcesses();
  const byParent = new Map();
  for (const item of processes) {
    const children = byParent.get(item.ppid) ?? [];
    children.push(item);
    byParent.set(item.ppid, children);
  }
  const descendants = [];
  const pending = [...(byParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) continue;
    descendants.push(item);
    pending.push(...(byParent.get(item.pid) ?? []));
  }
  return descendants;
}

function parseProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return undefined;
  return { command: match[3], pid: Number(match[1]), ppid: Number(match[2]) };
}

async function assertNoOrphans(processes, timeoutMs) {
  if (processes.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  const pids = new Set(processes.map((item) => item.pid));
  while (Date.now() < deadline) {
    const current = new Set(snapshotAllProcessIds());
    if (![...pids].some((pid) => current.has(pid))) return;
    await delay(POLL_INTERVAL_MS);
  }
  const survivors = snapshotProcessTreeFromPids(pids);
  throw new Error(`Packaged GUI left child processes after exit: ${survivors.map((item) => `${item.pid} ${item.command}`).join("; ")}`);
}

function snapshotAllProcessIds() {
  return snapshotProcesses().map((item) => item.pid);
}

function snapshotProcessTreeFromPids(pids) {
  return snapshotProcesses().filter((item) => pids.has(item.pid));
}

function snapshotProcesses() {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8" },
    ).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((item) => ({
        pid: Number(item.ProcessId),
        ppid: Number(item.ParentProcessId),
        command: String(item.CommandLine ?? ""),
      }))
      .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && Number.isInteger(item.ppid) && item.ppid >= 0);
  }

  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map(parseProcessLine)
    .filter((item) => item !== undefined);
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      rejectClose(new Error(`Desktop application did not exit after ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolveClose();
    };
    child.once("close", onClose);
  });
}

function findMacAppBundle(root) {
  if (root.endsWith(".app") && existsSync(join(root, "Contents", "Info.plist"))) return root;
  const direct = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (direct) return join(root, direct.name);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const nested = readdirSync(join(root, entry.name), { withFileTypes: true }).find(
      (candidate) => candidate.isDirectory() && candidate.name.endsWith(".app"),
    );
    if (nested) return join(root, entry.name, nested.name);
  }
  return undefined;
}

function macAppExecutable(appBundle) {
  const infoPlist = join(appBundle, "Contents", "Info.plist");
  let executableName = parse(appBundle).name;
  try {
    executableName = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlist], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Fall back to the conventional bundle name when plutil is unavailable.
  }
  const executable = join(appBundle, "Contents", "MacOS", executableName);
  if (!existsSync(executable)) throw new Error(`macOS app executable is missing: ${executable}`);
  return executable;
}

function findExecutableUnderDirectory(root, platform) {
  const expectedExtension = platform === "win32" ? ".exe" : "";
  const entries = readdirSync(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && (expectedExtension ? entry.name.toLowerCase().endsWith(expectedExtension) : true))
    .map((entry) => join(root, entry.name))
    .filter((path) => expectedExtension || isExecutable(path));
  if (candidates.length > 0) return candidates[0];
  const resources = join(root, "resources");
  if (existsSync(resources)) {
    const nested = findExecutableUnderDirectory(resources, platform);
    if (nested) return nested;
  }
  return undefined;
}

function isLaunchableArtifactFile(path, platform) {
  if (platform === "win32") return extname(path).toLowerCase() === ".exe";
  if (platform === "darwin") return isExecutable(path);
  return isExecutable(path) || extname(path).toLowerCase() === ".appimage";
}

function isExecutable(path) {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await closeServer(server);
  if (!port) throw new Error("Could not reserve a local DevTools port");
  return port;
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

function parseTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error(`--timeout must be an integer between 1000 and 300000 (received ${value})`);
  }
  return timeout;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isMainModule() {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
