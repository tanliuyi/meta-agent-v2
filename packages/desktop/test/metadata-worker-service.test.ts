import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Thread } from "../src/shared/contracts.ts";
import { MetadataWorkerService } from "../src/sidecar/metadata-worker-service.ts";

describe("MetadataWorkerService", () => {
  it("retries external session registration while a fresh session file materializes", async () => {
    const root = mkdtempSync(join(tmpdir(), "metadata-worker-materialization-"));
    const sessionFile = join(root, "child", "session.jsonl");
    const thread: Thread = {
      id: "materializing-child",
      projectId: "project",
      title: "Materializing child",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      preview: "Materializing child",
      archived: false,
      running: true,
      origin: "subagent",
    };
    const { service } = await MetadataWorkerService.create({
      role: "metadata",
      value: { agentDir: root, userDataDir: root },
    });

    try {
      const materialization = delay(20).then(() => {
        mkdirSync(dirname(sessionFile), { recursive: true });
        writeFileSync(
          sessionFile,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: thread.id,
            timestamp: new Date(thread.createdAt).toISOString(),
            cwd: root,
          })}\n`,
        );
      });
      const registration = service.command({
        type: "registerExternalSession",
        projectId: thread.projectId,
        cwd: root,
        sessionFile,
        thread,
      });

      await materialization;
      await expect(registration).resolves.toBeNull();
      await expect(
        service.command({ type: "resolveSession", projectId: thread.projectId, cwd: root, threadId: thread.id }),
      ).resolves.toEqual({ id: thread.id, path: sessionFile });
    } finally {
      await service.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
