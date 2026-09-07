/**
 * Identifier rules for Codex plugin and marketplace names.
 *
 * Mirrors the Codex plugin-creator skill's `identifier_validation.py`: plugin names
 * may contain ASCII letters, digits, `_`, `-` and `.` as a segment separator;
 * marketplace names allow ASCII letters, digits, `_` and `-`.
 */

export const CODEX_PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
export const CODEX_MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isCodexPluginName(value: string): boolean {
  return CODEX_PLUGIN_NAME_PATTERN.test(value);
}

export function isCodexMarketplaceName(value: string): boolean {
  return CODEX_MARKETPLACE_NAME_PATTERN.test(value);
}
