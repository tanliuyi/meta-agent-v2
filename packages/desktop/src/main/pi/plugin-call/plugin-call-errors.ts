export type PluginCallErrorCode =
  | "PLUGIN_CALL_ABORTED"
  | "PLUGIN_CALL_LIMIT_EXCEEDED"
  | "PLUGIN_CALL_TIMEOUT"
  | "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED"
  | "PLUGIN_ATTACHMENT_PATH_PRIVATE"
  | "PLUGIN_ARTIFACT_UNAVAILABLE"
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

export class PluginCallError extends Error {
  readonly code: PluginCallErrorCode;
  readonly pluginId?: string;
  readonly method?: string;

  constructor(code: PluginCallErrorCode, message: string = code, pluginId?: string, method?: string) {
    super(message);
    this.name = "PluginCallError";
    this.code = code;
    this.pluginId = pluginId;
    this.method = method;
  }
}

export function normalizePluginError(error: unknown, fallback: PluginCallErrorCode): PluginCallError {
  if (error instanceof PluginCallError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("PLUGIN_")
  ) {
    return new PluginCallError(
      error.code as PluginCallErrorCode,
      error instanceof Error ? error.message : String(error),
    );
  }
  return new PluginCallError(fallback, error instanceof Error ? error.message : String(error));
}
