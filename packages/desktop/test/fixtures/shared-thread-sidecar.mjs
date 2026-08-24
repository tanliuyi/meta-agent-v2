import { currentRuntimeCompatibility } from "../../src/shared/sidecar-wire.ts";
import { runSharedThreadSidecarHost } from "../../src/sidecar/shared-thread-sidecar-host.ts";

const compatibilityId = process.env.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID;
if (!compatibilityId) throw new Error("Missing PI_DESKTOP_RUNTIME_COMPATIBILITY_ID");

runSharedThreadSidecarHost(currentRuntimeCompatibility(compatibilityId), async (binding) => {
  const channelId = binding.value.mode === "create" ? binding.value.sessionId : binding.value.threadId;
  return {
    service: {
      command: async (command) => ({ channelId, command: command.type }),
      dispose: async () => {
        if (channelId === "dispose-error") throw new Error("fixture dispose failed");
      },
    },
    readyResult: {
      channelId,
      browserSessionToken: binding.value.browserSessionToken ?? null,
    },
  };
});
