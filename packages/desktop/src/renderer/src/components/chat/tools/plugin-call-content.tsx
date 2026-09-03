import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import type { PiPluginCallArtifact } from "../../../../../shared/contracts.ts";
import { useSessionScope } from "../../session-context.tsx";
import { ToolCode } from "./tool-code.tsx";
import { formatToolValue } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

interface PluginCallContentProps {
  args: Readonly<Record<string, unknown>>;
  result: unknown;
  error: boolean;
  artifact: unknown;
}

export function PluginCallContent({ args, result, error, artifact }: PluginCallContentProps) {
  const { record } = useSessionScope();
  const code = pluginCallCode(args);
  const parsed = parseArtifact(artifact);
  if (!parsed) {
    return (
      <>
        <ToolCode value={code} expanded />
        <ToolResult result={result} error={error} expanded />
      </>
    );
  }
  const { pluginCall, toolCallId } = parsed;
  return (
    <div className="plugin-call-details">
      {pluginCall.logs.length > 0 ? (
        <div className="plugin-call-logs" aria-label="Plugin logs">
          {pluginCall.logs.map((log) => (
            <div key={log.sequence} className="tool-code">
              [{log.level}] {log.text}
            </div>
          ))}
        </div>
      ) : null}
      <div className="plugin-call-list" aria-label="Plugin method calls">
        {pluginCall.calls.map((call) => (
          <div key={call.callId} className="plugin-call-row" data-state={call.state}>
            <span className="plugin-call-method">
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
      {pluginCall.attachments.length > 0 ? (
        <div className="plugin-call-attachments" aria-label="Plugin attachments">
          {pluginCall.attachments.map((attachment) =>
            attachment.type === "file" ? (
              <button
                key={attachment.artifactId}
                type="button"
                className="tool-expand-trigger"
                title={`Open ${attachment.name}`}
                aria-label={`Open ${attachment.name}`}
                onClick={() =>
                  void window.desktop.sessions.openPluginCallArtifact({
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

function pluginCallCode(args: Readonly<Record<string, unknown>>): string {
  return typeof args.code === "string" && args.code.length > 0 ? args.code : "(plugin code unavailable)";
}

function parseArtifact(value: unknown): { pluginCall: PiPluginCallArtifact; toolCallId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!record.pluginCall || typeof record.pluginCall !== "object" || typeof record.pluginCallToolCallId !== "string") {
    return undefined;
  }
  const pluginCall = record.pluginCall as PiPluginCallArtifact;
  return pluginCall.kind === "plugin-call" ? { pluginCall, toolCallId: record.pluginCallToolCallId } : undefined;
}
