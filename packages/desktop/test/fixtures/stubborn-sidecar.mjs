let workerInstanceId;

process.on("message", (message) => {
  if (message?.kind === "initialize") {
    process.stderr.write("fixture sidecar stderr\n");
    workerInstanceId = message.workerInstanceId;
    process.send?.({
      kind: "ready",
      protocolVersion: message.protocolVersion,
      workerInstanceId,
      role: message.binding.role,
      runtime: message.expectedRuntime,
    });
    return;
  }
  if (message?.kind === "request" && message.command?.type === "rename") return;
});
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setInterval(() => {}, 1_000);
