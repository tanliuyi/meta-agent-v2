import { errorMessage } from "@renderer/shared/lib/error-message";
import { useEffect, useState } from "react";
import type { NodeRuntimeProgress, NodeRuntimeStatus, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { NodeRuntimeBlocker } from "./node-runtime-blocker.tsx";

type RuntimeKind = "node" | "shell";

/** 隔离受管 runtime 探测与安装状态，避免其进度更新重渲染工作台。 */
export function NodeRuntimeGate() {
  const [nodeStatus, setNodeStatus] = useState<NodeRuntimeStatus | null>(null);
  const [shellStatus, setShellStatus] = useState<ShellRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<NodeRuntimeProgress | null>(null);
  const [installing, setInstalling] = useState<RuntimeKind | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.desktop.nodeRuntime.getStatus(),
      window.desktop.platform === "win32" ? window.desktop.shellRuntime.getStatus() : Promise.resolve(null),
    ]).then(([nextNodeStatus, nextShellStatus]) => {
      if (!active) return;
      setNodeStatus(nextNodeStatus);
      setShellStatus(nextShellStatus);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const removeNode = window.desktop.nodeRuntime.onProgress(setProgress);
    const removeShell = window.desktop.shellRuntime.onProgress(setProgress);
    return () => {
      removeNode();
      removeShell();
    };
  }, []);

  const install = async (kind: RuntimeKind) => {
    setInstalling(kind);
    setProgress(null);
    try {
      if (kind === "node") setNodeStatus(await window.desktop.nodeRuntime.install());
      else setShellStatus(await window.desktop.shellRuntime.install());
      window.desktop.runtime.restart();
    } catch (value) {
      const label = kind === "node" ? "Node.js" : "Git Bash";
      setProgress({ phase: "error", percent: 0, message: `${label} 安装失败`, error: errorMessage(value) });
    } finally {
      setInstalling(null);
    }
  };

  if (nodeStatus && nodeStatus.state !== "ready") {
    return (
      <NodeRuntimeBlocker
        kind="node"
        status={nodeStatus}
        progress={progress}
        installing={installing === "node"}
        onInstall={() => install("node")}
      />
    );
  }
  if (window.desktop.platform === "win32" && shellStatus && shellStatus.state !== "ready") {
    return (
      <NodeRuntimeBlocker
        kind="shell"
        status={shellStatus}
        progress={progress}
        installing={installing === "shell"}
        onInstall={() => install("shell")}
      />
    );
  }
  return null;
}
