import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import type { PiRunCodeArtifact } from "../../../../../shared/contracts.ts";
import { useSessionScope } from "../../session-context.tsx";
import { ToolCode } from "./tool-code.tsx";
import { formatToolValue } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

interface RunCodeContentProps {
  args: Readonly<Record<string, unknown>>;
  result: unknown;
  error: boolean;
  artifact: unknown;
}

export function RunCodeContent({ args, result, error, artifact }: RunCodeContentProps) {
  const { record } = useSessionScope();
  const code = runCodeCode(args);
  const parsed = parseArtifact(artifact);
  if (!parsed) {
    return (
      <>
        <ToolCode value={code} expanded />
        <ToolResult result={result} error={error} expanded />
      </>
    );
  }
  const { runCode, toolCallId } = parsed;
  return (
    <div className="run-code-details">
      {runCode.logs.length > 0 ? (
        <div className="run-code-logs" aria-label="Plugin logs">
          {runCode.logs.map((log) => (
            <div key={log.sequence} className="tool-code">
              [{log.level}] {log.text}
            </div>
          ))}
        </div>
      ) : null}
      <div className="run-code-list" aria-label="Plugin method calls">
        {runCode.calls.map((call) => (
          <div key={call.callId} className="run-code-row" data-state={call.state}>
            <span className="run-code-method">
              {call.pluginId}.{call.method}
            </span>
            <span className="tool-context">
              {call.state}
              {call.durationMs === undefined ? "" : ` · ${call.durationMs} ms`}
              {call.errorCode ? ` · ${call.errorCode}` : ""}
            </span>
            {call.progress !== undefined ? <ToolCode value={formatToolValue(call.progress)} expanded /> : null}
          </div>
        ))}
      </div>
      {runCode.attachments.length > 0 ? (
        <div className="run-code-attachments" aria-label="Plugin attachments">
          {runCode.attachments.map((attachment) =>
            attachment.type === "file" ? (
              <button
                key={attachment.artifactId}
                type="button"
                className="tool-expand-trigger"
                title={`Open ${attachment.name}`}
                aria-label={`Open ${attachment.name}`}
                onClick={() =>
                  void window.desktop.sessions.openRunCodeArtifact({
                    projectId: record.identity.projectId,
                    threadId: record.identity.threadId,
                    toolCallId,
                    artifactId: attachment.artifactId,
                  })
                }
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{attachment.displayPath}</span>
              </button>
            ) : (
              <span key={attachment.resourceId} className="tool-context">
                Image {attachment.name ?? attachment.mimeType}
              </span>
            ),
          )}
        </div>
      ) : null}
      <ToolResult result={result} error={error} expanded />
      <ToolCode value={code} expanded />
    </div>
  );
}

function runCodeCode(args: Readonly<Record<string, unknown>>): string {
  return typeof args.code === "string" && args.code.length > 0 ? args.code : "(plugin code unavailable)";
}

function parseArtifact(value: unknown): { runCode: PiRunCodeArtifact; toolCallId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!record.runCode || typeof record.runCode !== "object" || typeof record.runCodeToolCallId !== "string") {
    return undefined;
  }
  const runCode = record.runCode as PiRunCodeArtifact;
  return runCode.kind === "run-code" ? { runCode, toolCallId: record.runCodeToolCallId } : undefined;
}
