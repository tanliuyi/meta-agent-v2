import { spawn } from "node:child_process";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { ensureBinary } from "./binary.ts";
import type { ResolvedOfficeCliConfig } from "./types.ts";

/**
 * Thin wrapper around the officecli binary: spawn, capture output, parse the
 * `--json` envelope, normalize failures into model-readable errors.
 *
 * Every command supports `--json`; non-JSON commands (view text, help, ...)
 * return raw text. Errors carry structured codes and suggestions that are
 * passed through to the model so it can self-correct.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export function runOfficeCli(binary: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Node launcher shims (official npm wrapper and test fixtures) are .js files.
    const isScript = /\.(?:js|mjs|cjs)$/i.test(binary);
    const child = spawn(isScript ? process.execPath : binary, isScript ? [binary, ...args] : args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      // On Windows the close signal is always null even when killed by timeout.
      resolve({ stdout, stderr, code: code ?? -1, killed: timedOut || signal !== null });
    });
  });
}

/** Parse a `--json` envelope. Returns null when the text is not JSON. */
export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

interface OfficeErrorInfo {
  code: string;
  message: string;
  suggestion?: string;
}

/** Extract a structured error from an officecli JSON envelope or raw stderr. */
export function officeErrorFrom(text: string): OfficeErrorInfo | null {
  const parsed = tryParseJson(text);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).success === false
  ) {
    const error = (parsed as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const info = error as Record<string, unknown>;
      return {
        code: typeof info.code === "string" ? info.code : "officecli_error",
        message: typeof info.error === "string" ? info.error : JSON.stringify(info),
        suggestion: typeof info.suggestion === "string" ? info.suggestion : undefined,
      };
    }
  }
  return null;
}

export function formatOfficeError(info: OfficeErrorInfo): string {
  const suggestion = info.suggestion ? `。建议: ${info.suggestion}` : "";
  return `[${info.code}] ${info.message}${suggestion}`;
}

/** Runner bound to the resolved config; resolves the binary once per call. */
export interface CliRunner {
  run(
    args: string[],
    options: RunOptions & { json?: boolean },
  ): Promise<{ text: string; parsed: unknown | null }>;
}

export function createRunner(config: ResolvedOfficeCliConfig): CliRunner {
  return {
    async run(args, options) {
      const binary = await ensureBinary(config, options.signal);
      const result = await runOfficeCli(binary, args, options);
      if (result.code !== 0) {
        const error =
          officeErrorFrom(result.stdout) ??
          officeErrorFrom(result.stderr) ??
          (result.stderr.trim() ? { code: "exit", message: result.stderr.trim() } : null) ??
          (result.stdout.trim() ? { code: "exit", message: truncateHead(result.stdout).content } : null);
        if (error) throw new Error(formatOfficeError(error));
        throw new Error(`officecli 异常退出（code ${result.code}${result.killed ? ", killed" : ""}）`);
      }
      const text = result.stdout;
      const parsed = options.json ? tryParseJson(text) : null;
      return { text, parsed };
    },
  };
}
