import type { DesktopPlatform, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";

export interface ShellRuntimeDiagnosis {
  shellStatus: ShellRuntimeStatus | null;
}

let cachedDiagnosis: ShellRuntimeDiagnosis | undefined;
let diagnosisRequest: Promise<ShellRuntimeDiagnosis> | undefined;

export function getCachedShellRuntimeDiagnosis(platform: DesktopPlatform): Promise<ShellRuntimeDiagnosis> {
  if (cachedDiagnosis) return Promise.resolve(cachedDiagnosis);
  if (diagnosisRequest) return diagnosisRequest;
  if (platform !== "win32") {
    cachedDiagnosis = { shellStatus: null };
    return Promise.resolve(cachedDiagnosis);
  }
  diagnosisRequest = Promise.allSettled([window.desktop.shellRuntime.getStatus()])
    .then(([shellResult]) => {
      cachedDiagnosis = resolveShellRuntimeDiagnosis(shellResult, platform);
      return cachedDiagnosis;
    })
    .finally(() => {
      diagnosisRequest = undefined;
    });
  return diagnosisRequest;
}

export function peekShellRuntimeDiagnosis(): ShellRuntimeDiagnosis | undefined {
  return cachedDiagnosis;
}

export function resolveShellRuntimeDiagnosis(
  shellResult: PromiseSettledResult<ShellRuntimeStatus>,
  platform: DesktopPlatform,
): ShellRuntimeDiagnosis {
  if (platform !== "win32") return { shellStatus: null };
  return {
    shellStatus:
      shellResult.status === "fulfilled"
        ? shellResult.value
        : {
            state: "invalid",
            message: `Git Bash 诊断失败: ${errorMessage(shellResult.reason)}`,
            installUrl: "",
          },
  };
}
