import { errorMessage } from "@renderer/shared/lib/error-message";
import type { DesktopPlatform, NodeRuntimeStatus, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";

export interface RuntimeDiagnosis {
  nodeStatus: NodeRuntimeStatus;
  shellStatus: ShellRuntimeStatus | null;
}

let cachedDiagnosis: RuntimeDiagnosis | undefined;
let diagnosisRequest: Promise<RuntimeDiagnosis> | undefined;

export function getCachedRuntimeDiagnosis(platform: DesktopPlatform): Promise<RuntimeDiagnosis> {
  if (cachedDiagnosis) return Promise.resolve(cachedDiagnosis);
  if (diagnosisRequest) return diagnosisRequest;
  diagnosisRequest = Promise.allSettled([
    window.desktop.nodeRuntime.getStatus(),
    platform === "win32" ? window.desktop.shellRuntime.getStatus() : Promise.resolve(null),
  ])
    .then(([nodeResult, shellResult]) => {
      cachedDiagnosis = resolveRuntimeDiagnosis(nodeResult, shellResult, platform);
      return cachedDiagnosis;
    })
    .finally(() => {
      diagnosisRequest = undefined;
    });
  return diagnosisRequest;
}

export function peekRuntimeDiagnosis(): RuntimeDiagnosis | undefined {
  return cachedDiagnosis;
}

export function resolveRuntimeDiagnosis(
  nodeResult: PromiseSettledResult<NodeRuntimeStatus>,
  shellResult: PromiseSettledResult<ShellRuntimeStatus | null>,
  platform: DesktopPlatform,
): RuntimeDiagnosis {
  const nodeStatus: NodeRuntimeStatus =
    nodeResult.status === "fulfilled"
      ? nodeResult.value
      : {
          state: "invalid",
          requiredVersion: "",
          message: `Node.js 诊断失败: ${errorMessage(nodeResult.reason)}`,
          installUrl: "",
        };
  const shellStatus: ShellRuntimeStatus | null =
    platform !== "win32"
      ? null
      : shellResult.status === "fulfilled"
        ? shellResult.value
        : {
            state: "invalid",
            message: `Git Bash 诊断失败: ${errorMessage(shellResult.reason)}`,
            installUrl: "",
          };
  return { nodeStatus, shellStatus };
}
