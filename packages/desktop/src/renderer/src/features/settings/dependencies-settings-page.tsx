import { errorMessage } from "@renderer/shared/lib/error-message";
import { Button } from "@renderer/shared/ui/button";
import { useToast } from "@renderer/shared/ui/use-toast";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopPlatform,
  NodeRuntimeProgress,
  NodeRuntimeStatus,
  ShellRuntimeStatus,
} from "../../../../shared/desktop-api.ts";
import { resolveRuntimeDiagnosis } from "../node-runtime/runtime-diagnosis.ts";
import { DependencyRow } from "./dependency-row.tsx";

type RuntimeKind = "node" | "shell";

export function runtimeKindsToInstall(
  nodeStatus: NodeRuntimeStatus | null,
  shellStatus: ShellRuntimeStatus | null,
  platform: DesktopPlatform,
): RuntimeKind[] {
  const kinds: RuntimeKind[] = [];
  if (nodeStatus?.state !== "ready") kinds.push("node");
  if (platform === "win32" && shellStatus?.state !== "ready") kinds.push("shell");
  return kinds;
}

export function DependenciesSettingsPage() {
  const toast = useToast();
  const [nodeStatus, setNodeStatus] = useState<NodeRuntimeStatus | null>(null);
  const [shellStatus, setShellStatus] = useState<ShellRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<NodeRuntimeProgress | null>(null);
  const [progressKind, setProgressKind] = useState<RuntimeKind | null>(null);
  const [activeKind, setActiveKind] = useState<RuntimeKind | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [installingAll, setInstallingAll] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const diagnose = useCallback(async () => {
    setDiagnosing(true);
    setProgress(null);
    setProgressKind(null);
    try {
      const [nodeResult, shellResult] = await Promise.allSettled([
        window.desktop.nodeRuntime.getStatus(),
        window.desktop.platform === "win32" ? window.desktop.shellRuntime.getStatus() : Promise.resolve(null),
      ]);
      const diagnosis = resolveRuntimeDiagnosis(nodeResult, shellResult, window.desktop.platform);
      setNodeStatus(diagnosis.nodeStatus);
      setShellStatus(diagnosis.shellStatus);
    } catch (diagnosticError) {
      toast.notify({ title: "诊断失败", message: errorMessage(diagnosticError), tone: "error" });
    } finally {
      setDiagnosing(false);
    }
  }, [toast]);

  useEffect(() => {
    void diagnose();
  }, [diagnose]);

  useEffect(() => {
    const updateProgress = (nextProgress: NodeRuntimeProgress) => setProgress(nextProgress);
    const removeNode = window.desktop.nodeRuntime.onProgress(updateProgress);
    const removeShell = window.desktop.shellRuntime.onProgress(updateProgress);
    return () => {
      removeNode();
      removeShell();
    };
  }, []);

  const install = async (kind: RuntimeKind, restart = true): Promise<boolean> => {
    setActiveKind(kind);
    setProgressKind(kind);
    setProgress(null);
    try {
      if (kind === "node") setNodeStatus(await window.desktop.nodeRuntime.install());
      else setShellStatus(await window.desktop.shellRuntime.install());
      if (restart) window.desktop.runtime.restart();
      return true;
    } catch (installError) {
      const label = kind === "node" ? "Node.js" : "Git Bash";
      const message = errorMessage(installError);
      setProgress({ phase: "error", percent: 0, message: `${label} 安装失败`, error: message });
      toast.notify({ title: `${label} 安装失败`, message, tone: "error" });
      return false;
    } finally {
      setActiveKind(null);
    }
  };

  const installAll = async () => {
    setInstallingAll(true);
    try {
      const kinds = runtimeKindsToInstall(nodeStatus, shellStatus, window.desktop.platform);
      for (const kind of kinds) {
        if (!(await install(kind, false))) return;
      }
      if (kinds.length > 0) window.desktop.runtime.restart();
    } finally {
      setInstallingAll(false);
    }
  };

  const chooseShell = async () => {
    setChoosing(true);
    setActiveKind("shell");
    setProgressKind("shell");
    setProgress(null);
    try {
      const status = await window.desktop.shellRuntime.choose();
      if (!status) return;
      setShellStatus(status);
      window.desktop.runtime.restart();
    } catch (selectionError) {
      const message = errorMessage(selectionError);
      setProgress({ phase: "error", percent: 0, message: "Git Bash 检查失败", error: message });
      toast.notify({ title: "Git Bash 不可用", message, tone: "error" });
    } finally {
      setActiveKind(null);
      setChoosing(false);
    }
  };

  const busy = diagnosing || installingAll || choosing || activeKind !== null;
  const allReady =
    nodeStatus?.state === "ready" && (window.desktop.platform !== "win32" || shellStatus?.state === "ready");

  return (
    <div className="settings-content dependency-settings">
      <header className="settings-page-heading dependency-page-heading">
        <div>
          <h2>依赖项</h2>
          <p>管理 Desktop sidecar 所需的运行环境</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void diagnose()}>
          <RefreshCw className={diagnosing ? "dependency-spin" : undefined} />
          诊断
        </Button>
      </header>

      <section className="settings-section" aria-labelledby="runtime-dependencies-heading">
        <div className="settings-section-heading">
          <h3 id="runtime-dependencies-heading">运行环境</h3>
        </div>
        <DependencyRow
          label="Node.js"
          status={nodeStatus}
          progress={progressKind === "node" ? progress : null}
          installing={activeKind === "node"}
          busy={busy}
          onInstall={() => install("node")}
        />
        {window.desktop.platform === "win32" ? (
          <DependencyRow
            label="Git Bash"
            status={shellStatus}
            progress={progressKind === "shell" ? progress : null}
            installing={activeKind === "shell" && !choosing}
            choosing={choosing}
            busy={busy}
            onChoose={chooseShell}
            onInstall={() => install("shell")}
          />
        ) : null}
      </section>

      <div className="dependency-footer">
        <Button disabled={busy || allReady} onClick={() => void installAll()}>
          <Download />
          {installingAll ? "安装中" : allReady ? "全部可用" : "全部安装"}
        </Button>
      </div>
    </div>
  );
}
