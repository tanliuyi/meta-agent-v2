import { currentRuntimeCompatibility } from "../../src/shared/sidecar-wire.ts";
import { runSidecarHost } from "../../src/sidecar/sidecar-host.ts";

const compatibilityId = process.env.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID;
if (!compatibilityId) throw new Error("PI_DESKTOP_RUNTIME_COMPATIBILITY_ID is required");

runSidecarHost(currentRuntimeCompatibility(compatibilityId), async (_binding, context) => ({
  service: {
    async command(command) {
      if (command.type === "ping") {
        for (let index = 0; index < 800; index += 1) context.emit({ type: "runtime-state", state: "busy" });
        return { pong: true };
      }
      if (command.type === "bootstrap") return null;
      return null;
    },
    async dispose() {},
  },
}));
