import { describe, expect, it } from "vitest";
import {
  MEMORY_POLICY_PROMPT,
  MEMORY_POLICY_PROMPT_COMPACT,
} from "../src/main/pi/extensions/pi-hermes-memory/constants.ts";

describe("Desktop Hermes memory prompt", () => {
  it.each([MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT])(
    "keeps plugin methods out of the initial system prompt",
    (prompt) => {
      expect(prompt).toContain("Read the matching plugin skill before");
      expect(prompt).not.toContain("<available-memory-tools>");
      expect(prompt).not.toMatch(/\b(?:memory_search|session_search|skill_manage)\b/);
      expect(prompt).not.toContain('target accepts "memory"');
    },
  );
});
