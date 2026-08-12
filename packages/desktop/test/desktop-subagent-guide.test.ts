import { describe, expect, it } from "vitest";
import {
  readSubagentGuide,
  SUBAGENT_GUIDE_TOPICS,
} from "../src/main/pi/extensions/pi-subagents/src/extension/subagent-guide.ts";

describe("Desktop subagent guide resources", () => {
  it("loads every advertised guide topic from the packaged resource tree", () => {
    for (const topic of SUBAGENT_GUIDE_TOPICS) {
      const content = readSubagentGuide(topic);
      expect(content.length, topic).toBeGreaterThan(0);
      expect(content, topic).not.toContain("Failed to read packaged subagents guide");
    }
  });
});
