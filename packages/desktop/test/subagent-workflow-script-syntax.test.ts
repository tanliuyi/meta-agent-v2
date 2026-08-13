import { describe, expect, it } from "vitest";
import {
  SubagentParams,
  SubagentParamsWithoutLegacyChainControls,
} from "../src/main/pi/extensions/pi-subagents/src/extension/schemas.ts";
import {
  COMPACT_SUBAGENT_TOOL_DESCRIPTION,
  FULL_SUBAGENT_TOOL_DESCRIPTION,
} from "../src/main/pi/extensions/pi-subagents/src/extension/tool-description.ts";
import {
  runWorkflowScript,
  type WorkflowScriptChildResult,
  WorkflowScriptError,
} from "../src/main/pi/extensions/pi-subagents/src/workflows/scripted-workflow.ts";

function completedChild(key: string): WorkflowScriptChildResult {
  return { key, ok: true, output: `output of ${key}`, artifactPaths: [] };
}

async function captureError(options: Parameters<typeof runWorkflowScript>[0]): Promise<Error> {
  return await runWorkflowScript(options).then(
    () => {
      throw new Error("expected runWorkflowScript to reject");
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

describe("workflowScript syntax diagnostics", () => {
  it.each(['"', "'"])("reports a bare newline inside a %s-quoted string with targeted advice", async (quote) => {
    const script = `return runs.run(${quote}main${quote}, {agent:${quote}worker${quote}, task:${quote}line one\nline two${quote}});`;
    const error = await captureError({
      script,
      launch: async (key) => completedChild(key),
      status: async (keyOrRunId) => ({ ...completedChild(keyOrRunId), runId: "run-1" }),
    });
    expect(error).toBeInstanceOf(WorkflowScriptError);
    expect(error.message).toContain("workflowScript must be valid JavaScript.");
    expect(error.message).toContain("raw newline inside a single- or double-quoted string");
    expect(error.message).toContain("Keep every quoted array item on one line");
    expect(error.message).toContain('use the escape "\\n"');
    expect(error.message).toContain('["line 1","line 2"].join("\\n")');
  });

  it("runs a single-line quoted array joined with the \\n escape and passes the multi-line task to launch", async () => {
    const launched: Array<{ key: string; task: string }> = [];
    const result = await runWorkflowScript({
      script: 'const task = ["line one","line two"].join("\\n"); return runs.run("main", {agent:"worker", task});',
      launch: async (key, params) => {
        launched.push({ key, task: String(params.task) });
        return completedChild(key);
      },
      status: async (keyOrRunId) => ({ ...completedChild(keyOrRunId), runId: "run-1" }),
    });
    expect(launched).toEqual([{ key: "main", task: "line one\nline two" }]);
    expect(result.children).toMatchObject([{ key: "main", ok: true }]);
  });

  it("keeps the Markdown fences/backticks hint for raw backtick template literals", async () => {
    const script = [
      "const task = `Run:",
      "```bash",
      "npm test",
      "```",
      "`;",
      "return runs.run('main', {agent:'worker', task});",
    ].join("\n");
    const error = await captureError({
      script,
      launch: async (key) => completedChild(key),
      status: async (keyOrRunId) => ({ ...completedChild(keyOrRunId), runId: "run-1" }),
    });
    expect(error).toBeInstanceOf(WorkflowScriptError);
    expect(error.message).toContain("Markdown fences");
    expect(error.message).toContain("backticks");
  });
});

describe("workflowScript single-line quoting guidance", () => {
  it("keeps the rule in the tool schema workflowScript descriptions", () => {
    for (const schema of [SubagentParams, SubagentParamsWithoutLegacyChainControls]) {
      const description = schema.properties.workflowScript.description;
      expect(description).toContain("Keep every quoted string on one line");
      expect(description).toContain("raw newline inside quotes is a syntax error");
      expect(description).toContain("use the \\n escape");
      expect(description).toContain('["a","b"].join("\\n")');
    }
  });

  it("keeps the rule in full and compact tool descriptions", () => {
    expect(FULL_SUBAGENT_TOOL_DESCRIPTION).toContain(
      "Each quoted line item must stay on one line: a raw newline inside single or double quotes is a syntax error",
    );
    expect(FULL_SUBAGENT_TOOL_DESCRIPTION).toContain('join("\\n")');
    expect(COMPACT_SUBAGENT_TOOL_DESCRIPTION).toContain(
      "Each quoted line item must stay on one line: a raw newline inside single or double quotes is a syntax error",
    );
  });
});
