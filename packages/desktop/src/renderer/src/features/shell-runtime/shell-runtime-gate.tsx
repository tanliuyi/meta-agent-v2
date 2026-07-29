import { useEffect, useState } from "react";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";
import { getCachedShellRuntimeDiagnosis, peekShellRuntimeDiagnosis } from "./runtime-diagnosis.ts";
import { ShellRuntimeBlocker } from "./shell-runtime-blocker.tsx";

export function ShellRuntimeGate() {
  const initialDiagnosis = peekShellRuntimeDiagnosis();
  const [status, setStatus] = useState<ShellRuntimeStatus | null>(initialDiagnosis?.shellStatus ?? null);
  const [progress, setProgress] = useState<ShellRuntimeProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (window.desktop.platform !== "win32") return;
    let active = true;
    void getCachedShellRuntimeDiagnosis(window.desktop.platform).then((diagnosis) => {
      if (!active) return;
      const previewMissing =
        import.meta.env.DEV && new URLSearchParams(window.location.search).get("runtimePreview") === "missing";
      setStatus(
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
    if (window.desktop.platform !== "win32") return;
    return window.desktop.shellRuntime.onProgress(setProgress);
  }, []);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setProgress(null);
    try {
      setStatus(await window.desktop.shellRuntime.install());
      window.desktop.runtime.restart();
    } catch (value) {
      setProgress({ phase: "error", percent: 0, message: "Git Bash 安装失败", error: errorMessage(value) });
    } finally {
      setInstalling(false);
    }
  };

  const choose = async (): Promise<void> => {
    setChoosing(true);
    setProgress(null);
    try {
      const nextStatus = await window.desktop.shellRuntime.choose();
      if (!nextStatus) return;
      setStatus(nextStatus);
      window.desktop.runtime.restart();
    } catch (value) {
      setProgress({ phase: "error", percent: 0, message: "Git Bash 检查失败", error: errorMessage(value) });
    } finally {
      setChoosing(false);
    }
  };

  if (window.desktop.platform !== "win32" || !status || status.state === "ready") return null;
  return (
    <ShellRuntimeBlocker
      status={status}
      progress={progress}
      installing={installing}
      choosing={choosing}
      onInstall={install}
      onChoose={choose}
    />
  );
}
