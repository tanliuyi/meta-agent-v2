import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(join(testHome, ".config", "rpiv-ask-user-question"), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
