import { currentRuntimeCompatibility } from "../shared/sidecar-wire.ts";
import { runSharedThreadSidecarHost } from "./shared-thread-sidecar-host.ts";

const compatibilityId = process.env.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID;
if (!compatibilityId) throw new Error("PI_DESKTOP_RUNTIME_COMPATIBILITY_ID is required");

runSharedThreadSidecarHost(currentRuntimeCompatibility(compatibilityId));
