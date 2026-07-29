import { fork } from "node:child_process";
import { resolve } from "node:path";

process.on("message", (message) => {
  if (message?.kind === "initialize") {
    const nested = fork(resolve(import.meta.dirname, "nested-fork-child.mjs"), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    nested.once("message", (nestedResult) => {
      process.send?.({
        kind: "ready",
        protocolVersion: message.protocolVersion,
        workerInstanceId: message.workerInstanceId,
        role: message.binding.role,
        runtime: message.expectedRuntime,
        result: {
          execPath: process.execPath,
          electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
          nested: nestedResult,
        },
      });
      nested.disconnect();
    });
    return;
  }
  if (message?.kind === "shutdown") process.exit(0);
});
