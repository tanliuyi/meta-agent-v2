import { VERSION } from "@earendil-works/pi-coding-agent";
import { currentRuntimeCompatibility } from "../shared/sidecar-wire.ts";
import { runSidecarHost } from "./sidecar-host.ts";
import { SubagentWorkerService } from "./subagent-worker-service.ts";

const compatibilityId = process.env.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID;
if (!compatibilityId) throw new Error("PI_DESKTOP_RUNTIME_COMPATIBILITY_ID is required");

runSidecarHost(currentRuntimeCompatibility(VERSION, compatibilityId), (binding, context) =>
  SubagentWorkerService.create(binding, context),
);
