let workerInstanceId;

process.on("message", (message) => {
  if (message?.kind === "initialize") {
    workerInstanceId = message.workerInstanceId;
    process.send?.({
      kind: "ready",
      protocolVersion: message.protocolVersion,
      workerInstanceId,
      role: message.binding.role,
      runtime: message.expectedRuntime,
    });
    process.send?.({
      kind: "host-call",
      protocolVersion: message.protocolVersion,
      workerInstanceId,
      requestId: "late-host-call",
      request: {
        type: "subagent.cancel",
        projectId: "project",
        parentThreadId: "thread",
        runId: "run",
        childIndex: 0,
      },
    });
    return;
  }
  if (message?.kind === "shutdown") process.exit(0);
});
