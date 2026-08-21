import { currentRuntimeCompatibility } from "../shared/sidecar-wire.ts";
import { runSidecarHost } from "./sidecar-host.ts";
import { ThreadWorkerService } from "./thread-worker-service.ts";

const compatibilityId = process.env.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID;
if (!compatibilityId) throw new Error("PI_DESKTOP_RUNTIME_COMPATIBILITY_ID is required");

runSidecarHost(currentRuntimeCompatibility(compatibilityId), (binding, context) =>
  ThreadWorkerService.create(binding, context),
);
