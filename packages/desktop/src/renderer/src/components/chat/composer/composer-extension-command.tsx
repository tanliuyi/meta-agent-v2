import { useAui } from "@assistant-ui/react";
import { useEffect } from "react";
import type { RpcExtensionHostState } from "../../../../../shared/contracts.ts";

const appliedRevisions = new Map<string, number>();

interface ComposerExtensionCommandProps {
  projectId: string;
  threadId: string;
  command: RpcExtensionHostState["composerCommand"];
}

/** Applies one-way extension composer commands without mirroring renderer keystrokes to the sidecar. */
export function ComposerExtensionCommand({ store, command }: ComposerExtensionCommandProps) {
  const aui = useAui();

  useEffect(() => {
    if (!command || !store.applyRevision(command.hostId, command.revision)) return;
    const current = aui.composer().getState().text;
    aui.composer().setText(command.mode === "append" ? `${current}${command.text}` : command.text);
  }, [aui, command, store]);

  return null;
}
