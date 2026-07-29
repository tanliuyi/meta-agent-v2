import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useCallback, useEffect, useState } from "react";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";
import { Button } from "../../shared/ui/button.tsx";
import { useToast } from "../../shared/ui/use-toast.ts";
import { resolveShellRuntimeDiagnosis } from "../shell-runtime/runtime-diagnosis.ts";
import { DependencyRow } from "./dependency-row.tsx";

export function DependenciesSettingsPage() {
  const toast = useToast();
  const [shellStatus, setShellStatus] = useState<ShellRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<ShellRuntimeProgress | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const diagnose = useCallback(async () => {
    setDiagnosing(true);
    setProgress(null);
    try {
      if (window.desktop.platform !== "win32") {
        setShellStatus(null);
        return;
      }
      const [result] = await Promise.allSettled([window.desktop.shellRuntime.getStatus()]);
      setShellStatus(resolveShellRuntimeDiagnosis(result, window.desktop.platform).shellStatus);
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
    if (window.desktop.platform !== "win32") return;
    return window.desktop.shellRuntime.onProgress(setProgress);
  }, []);

  const install = async (): Promise<boolean> => {
    setInstalling(true);
    setProgress(null);
    try {
      setShellStatus(await window.desktop.shellRuntime.install());
      window.desktop.runtime.restart();
      return true;
    } catch (installError) {
      const message = errorMessage(installError);
      setProgress({ phase: "error", percent: 0, message: "Git Bash 安装失败", error: message });
      toast.notify({ title: "Git Bash 安装失败", message, tone: "error" });
      return false;
    } finally {
      setInstalling(false);
    }
  };

  const chooseShell = async () => {
    setChoosing(true);
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
      setChoosing(false);
    }
  };

  const busy = diagnosing || installing || choosing;

  return (
    <div className="settings-content dependency-settings">
      <header className="settings-page-heading dependency-page-heading">
        <div>
          <h2>依赖项</h2>
          <p>管理 Desktop 使用的 Git Bash</p>
        </div>
        {window.desktop.platform === "win32" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void diagnose()}>
            <RefreshCw className={diagnosing ? "dependency-spin" : undefined} />
            诊断
          </Button>
        ) : null}
      </header>

      {window.desktop.platform === "win32" ? (
        <section className="settings-section" aria-labelledby="runtime-dependencies-heading">
          <div className="settings-section-heading">
            <h3 id="runtime-dependencies-heading">运行环境</h3>
          </div>
          <DependencyRow
            label="Git Bash"
            status={shellStatus}
            progress={progress}
            installing={installing}
            choosing={choosing}
            busy={busy}
            onChoose={chooseShell}
            onInstall={install}
          />
        </section>
      ) : null}
    </div>
  );
}
