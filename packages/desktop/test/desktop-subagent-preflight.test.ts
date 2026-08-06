import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSubagentLaunchContract } from "../src/main/pi/extensions/pi-subagents/src/api/preflight.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Desktop subagent preflight", () => {
  it("resolves a builtin without CLI lifecycle dependencies and reports host-owned tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "desktop-subagent-preflight-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const settingsPath = join(cwd, ".pi", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        subagents: {
          agentOverrides: {
            delegate: {
              tools: ["read", "mcp:test-server/search"],
              extensions: ["./test-extension.ts"],
            },
          },
        },
      }),
    );

    const result = await resolveSubagentLaunchContract({
      agent: "delegate",
      agentScope: "project",
      cwd,
      task: "inspect the project",
      artifacts: false,
      sessionRoot: join(cwd, "sessions"),
      runId: "preflight-focused",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.contract.agent).toMatchObject({ name: "delegate", source: "builtin" });
    expect(result.contract.roots.lifecycle).toEqual({
      asyncDir: expect.any(String),
      resultPath: expect.any(String),
      statusPath: expect.any(String),
      eventsPath: expect.any(String),
    });
    expect(result.contract.tools).toMatchObject({
      configuredExtensions: ["./test-extension.ts"],
      mcp: [expect.objectContaining({ selector: "test-server/search" })],
      effectiveMcpTools: [],
    });
    expect(result.contract.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "host_required",
          severity: "host-required",
          message: expect.stringContaining("Extension paths"),
        }),
        expect.objectContaining({
          code: "host_required",
          severity: "host-required",
          message: expect.stringContaining("Direct MCP"),
        }),
      ]),
    );

    const sourcePath = fileURLToPath(
      new URL("../src/main/pi/extensions/pi-subagents/src/api/preflight.ts", import.meta.url),
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/pi-args|process-terminal/);
  });
});
