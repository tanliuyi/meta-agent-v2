import { useAui } from "@assistant-ui/react";
import { useEffect } from "react";
import type { DesktopExtensionHostState } from "../../../../shared/contracts.ts";

const appliedRevisions = new Map<string, number>();

interface ComposerExtensionCommandProps {
  projectId: string;
  threadId: string;
  command: DesktopExtensionHostState["composerCommand"];
}

/** Applies one-way extension composer commands without mirroring renderer keystrokes to the sidecar. */
export function ComposerExtensionCommand({ projectId, threadId, command }: ComposerExtensionCommandProps) {
  const aui = useAui();
  const target = `${projectId}:${threadId}`;

  useEffect(() => {
    if (!command) return;
    const commandTarget = `${target}:${command.hostId}`;
    if ((appliedRevisions.get(commandTarget) ?? 0) >= command.revision) return;
    appliedRevisions.set(commandTarget, command.revision);
    const current = aui.composer().getState().text;
    aui.composer().setText(command.mode === "append" ? `${current}${command.text}` : command.text);
  }, [aui, command, target]);

  return null;
}
