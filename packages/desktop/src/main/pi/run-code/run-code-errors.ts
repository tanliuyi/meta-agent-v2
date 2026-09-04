export type RunCodeErrorCode =
  | "PLUGIN_CALL_ABORTED"
  | "PLUGIN_CALL_LIMIT_EXCEEDED"
  | "PLUGIN_CALL_TIMEOUT"
  | "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED"
  | "PLUGIN_CODE_EXCEPTION"
  | "PLUGIN_CODE_INVALID_OUTPUT"
  | "PLUGIN_CODE_SYNTAX_ERROR"
  | "PLUGIN_CODE_WORKER_EXIT"
  | "PLUGIN_GENERATION_STALE"
  | "PLUGIN_INVALID_JSON"
  | "PLUGIN_METHOD_EXECUTION_FAILED"
  | "PLUGIN_METHOD_INVALID_ARGUMENTS"
  | "PLUGIN_METHOD_INVALID_RESULT"
  | "PLUGIN_METHOD_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_OUTPUT_LIMIT_EXCEEDED"
  | "PLUGIN_PROGRESS_LIMIT_EXCEEDED"
  | "PLUGIN_RESPONSE_LIMIT_EXCEEDED";

const RUN_CODE_ERROR_CODES = new Set<RunCodeErrorCode>([
  "PLUGIN_CALL_ABORTED",
  "PLUGIN_CALL_LIMIT_EXCEEDED",
  "PLUGIN_CALL_TIMEOUT",
  "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED",
  "PLUGIN_CODE_EXCEPTION",
  "PLUGIN_CODE_INVALID_OUTPUT",
  "PLUGIN_CODE_SYNTAX_ERROR",
  "PLUGIN_CODE_WORKER_EXIT",
  "PLUGIN_GENERATION_STALE",
  "PLUGIN_INVALID_JSON",
  "PLUGIN_METHOD_EXECUTION_FAILED",
  "PLUGIN_METHOD_INVALID_ARGUMENTS",
  "PLUGIN_METHOD_INVALID_RESULT",
  "PLUGIN_METHOD_NOT_FOUND",
  "PLUGIN_NOT_FOUND",
  "PLUGIN_OUTPUT_LIMIT_EXCEEDED",
  "PLUGIN_PROGRESS_LIMIT_EXCEEDED",
  "PLUGIN_RESPONSE_LIMIT_EXCEEDED",
]);

export class RunCodeError extends Error {
  readonly code: RunCodeErrorCode;
  readonly pluginId?: string;
  readonly method?: string;

  constructor(code: RunCodeErrorCode, message: string = code, pluginId?: string, method?: string) {
    super(message);
    this.name = "RunCodeError";
    this.code = code;
    this.pluginId = pluginId;
    this.method = method;
  }
}

export function normalizePluginError(error: unknown, fallback: RunCodeErrorCode): RunCodeError {
  if (error instanceof RunCodeError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    isRunCodeErrorCode(error.code)
  ) {
    return new RunCodeError(error.code, error instanceof Error ? error.message : String(error));
  }
  return new RunCodeError(fallback, error instanceof Error ? error.message : String(error));
}

export function isRunCodeErrorCode(value: string | undefined): value is RunCodeErrorCode {
  return value !== undefined && RUN_CODE_ERROR_CODES.has(value as RunCodeErrorCode);
}
