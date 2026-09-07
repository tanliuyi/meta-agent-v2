import { spawn } from "node:child_process";
import { join } from "node:path";

/** Each invocation owns a process group, including ordinary grandchildren. */
export async function executeCodexScript(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let killIssued = false;
    let killPromise: Promise<void> | undefined;
    const killTree = (): Promise<void> => {
      if (!child.pid || killIssued) return killPromise ?? Promise.resolve();
      killIssued = true;
      if (process.platform === "win32") {
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(child.pid)],
          { stdio: "ignore", windowsHide: true },
        );
        killer.unref();
        killPromise = new Promise<void>((resolve) => killer.once("close", () => resolve()));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
        killPromise = Promise.resolve();
      }
      return killPromise;
    };
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (killIssued) return;
      killTree();
    };
    const abort = () => stop("CODEX_SCRIPT_CANCELLED");
    const timer = setTimeout(() => stop("CODEX_SCRIPT_TIMEOUT"), options.timeoutMs ?? 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    process.once("exit", killTree);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) stop("CODEX_SCRIPT_OUTPUT_LIMIT");
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => {
      failure ??= new Error("CODEX_SCRIPT_START_FAILED");
    });
    // A parent can exit while descendants still hold the output pipes open.
    child.once("exit", killTree);
    child.once("close", async (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      process.removeListener("exit", killTree);
      await (failure ? killTree() : Promise.resolve());
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`CODEX_SCRIPT_FAILED: ${code}`));
      else resolve(Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8"));
    });
    if (options.signal.aborted) abort();
  });
}
