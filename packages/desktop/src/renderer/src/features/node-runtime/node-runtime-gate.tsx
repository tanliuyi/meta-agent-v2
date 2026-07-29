import { errorMessage } from "@renderer/shared/lib/error-message";
import { useEffect, useState } from "react";
import type { NodeRuntimeProgress, NodeRuntimeStatus, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { NodeRuntimeBlocker, type RuntimeRequirement } from "./node-runtime-blocker.tsx";
import { getCachedRuntimeDiagnosis, peekRuntimeDiagnosis } from "./runtime-diagnosis.ts";

type RuntimeKind = "node" | "shell";

/** 隔离受管 runtime 探测与安装状态，避免其进度更新重渲染工作台。 */
export function NodeRuntimeGate() {
  const initialDiagnosis = peekRuntimeDiagnosis();
  const [nodeStatus, setNodeStatus] = useState<NodeRuntimeStatus | null>(initialDiagnosis?.nodeStatus ?? null);
  const [shellStatus, setShellStatus] = useState<ShellRuntimeStatus | null>(initialDiagnosis?.shellStatus ?? null);
  const [progress, setProgress] = useState<NodeRuntimeProgress | null>(null);
  const [progressKind, setProgressKind] = useState<RuntimeKind | null>(null);
  const [installing, setInstalling] = useState<RuntimeKind | null>(null);
  const [installingAll, setInstallingAll] = useState(false);
  const [choosingShell, setChoosingShell] = useState(false);

  useEffect(() => {
    let active = true;
    void getCachedRuntimeDiagnosis(window.desktop.platform).then((diagnosis) => {
      if (!active) return;
      const previewMissing =
        import.meta.env.DEV && new URLSearchParams(window.location.search).get("runtimePreview") === "missing";
      setNodeStatus(
        previewMissing
          ? { ...diagnosis.nodeStatus, state: "missing", path: undefined, version: undefined, message: "Node.js 缺失" }
          : diagnosis.nodeStatus,
      );
      setShellStatus(
        previewMissing && diagnosis.shellStatus
          ? {
              ...diagnosis.shellStatus,
              state: "missing",
              path: undefined,
              version: undefined,
              message: "Git Bash 缺失",
            }
          : diagnosis.shellStatus,
      );
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

  const install = async (kind: RuntimeKind, restart = true): Promise<boolean> => {
    setInstalling(kind);
    setProgressKind(kind);
    setProgress(null);
    try {
      if (kind === "node") setNodeStatus(await window.desktop.nodeRuntime.install());
      else setShellStatus(await window.desktop.shellRuntime.install());
      if (restart) window.desktop.runtime.restart();
      return true;
    } catch (value) {
      const label = kind === "node" ? "Node.js" : "Git Bash";
      setProgress({ phase: "error", percent: 0, message: `${label} 安装失败`, error: errorMessage(value) });
      return false;
    } finally {
      setInstalling(null);
    }
  };

  const installAll = async () => {
    setInstallingAll(true);
    try {
      const kinds: RuntimeKind[] = [];
      if (nodeStatus?.state !== "ready") kinds.push("node");
      if (window.desktop.platform === "win32" && shellStatus?.state !== "ready") kinds.push("shell");
      for (const kind of kinds) {
        if (!(await install(kind, false))) return;
      }
      window.desktop.runtime.restart();
    } finally {
      setInstallingAll(false);
    }
  };

  const chooseShell = async () => {
    setChoosingShell(true);
    setProgressKind("shell");
    setProgress(null);
    try {
      const nextStatus = await window.desktop.shellRuntime.choose();
      if (!nextStatus) return;
      setShellStatus(nextStatus);
      window.desktop.runtime.restart();
    } catch (value) {
      setProgress({ phase: "error", percent: 0, message: "Git Bash 检查失败", error: errorMessage(value) });
    } finally {
      setChoosingShell(false);
    }
  };

  const requirements: RuntimeRequirement[] = [];
  if (nodeStatus && nodeStatus.state !== "ready") {
    requirements.push({
      kind: "node",
      status: nodeStatus,
      progress: progressKind === "node" ? progress : null,
      installing: installing === "node",
      choosing: false,
      onInstall: () => install("node"),
    });
  }
  if (window.desktop.platform === "win32" && shellStatus && shellStatus.state !== "ready") {
    requirements.push({
      kind: "shell",
      status: shellStatus,
      progress: progressKind === "shell" ? progress : null,
      installing: installing === "shell",
      choosing: choosingShell,
      onInstall: () => install("shell"),
      onChoose: chooseShell,
    });
  }
  return requirements.length > 0 ? (
    <NodeRuntimeBlocker requirements={requirements} installingAll={installingAll} onInstallAll={installAll} />
  ) : null;
}
