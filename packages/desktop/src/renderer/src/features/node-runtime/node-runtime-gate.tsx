import { errorMessage } from "@renderer/shared/lib/error-message";
import { useEffect, useState } from "react";
import type { NodeRuntimeProgress, NodeRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { NodeRuntimeBlocker } from "./node-runtime-blocker.tsx";

/** 隔离 Node runtime 探测与安装状态，避免其进度更新重渲染工作台。 */
export function NodeRuntimeGate() {
  const [status, setStatus] = useState<NodeRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<NodeRuntimeProgress | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let active = true;
    void window.desktop.nodeRuntime.getStatus().then((nextStatus) => {
      if (active) setStatus(nextStatus);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => window.desktop.nodeRuntime.onProgress(setProgress), []);

  const install = async () => {
    setInstalling(true);
    try {
      setStatus(await window.desktop.nodeRuntime.install());
    } catch (value) {
      setProgress({ phase: "error", percent: 0, message: "Node.js 安装失败", error: errorMessage(value) });
    } finally {
      setInstalling(false);
    }
  };

  return status && status.state !== "ready" ? (
    <NodeRuntimeBlocker status={status} progress={progress} installing={installing} onInstall={install} />
  ) : null;
}
