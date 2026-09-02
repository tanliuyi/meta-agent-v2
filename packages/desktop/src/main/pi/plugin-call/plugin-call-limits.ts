export interface PluginCallLimits {
  maxCalls: number;
  maxConcurrentCalls: number;
  timeoutMs: number;
  computeTimeoutMs: number;
  maxCodeBytes: number;
  maxMethodResponseBytes: number;
  maxCumulativeResponseBytes: number;
  maxOuterOutputBytes: number;
  maxLogBytes: number;
  maxProgressBytes: number;
  maxCumulativeProgressBytes: number;
  maxAttachments: number;
  maxImageBytes: number;
  maxFileBytes: number;
  maxCumulativeFileBytes: number;
  maxOldGenerationSizeMb: number;
}

export const DEFAULT_PLUGIN_CALL_LIMITS: PluginCallLimits = Object.freeze({
  maxCalls: 64,
  maxConcurrentCalls: 8,
  timeoutMs: 120_000,
  computeTimeoutMs: 30_000,
  maxCodeBytes: 256 * 1024,
  maxMethodResponseBytes: 16 * 1024 * 1024,
  maxCumulativeResponseBytes: 64 * 1024 * 1024,
  maxOuterOutputBytes: 1024 * 1024,
  maxLogBytes: 256 * 1024,
  maxProgressBytes: 64 * 1024,
  maxCumulativeProgressBytes: 1024 * 1024,
  maxAttachments: 20,
  maxImageBytes: 32 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxCumulativeFileBytes: 512 * 1024 * 1024,
  maxOldGenerationSizeMb: 256,
});
