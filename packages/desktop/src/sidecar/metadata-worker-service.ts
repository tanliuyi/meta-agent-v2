import { rm } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateResolvedExtensionSet } from "../main/pi/desktop-extension-runtime-policy.ts";
import { loadDraftSessionConfig } from "../main/pi/session-configuration.ts";
import type { MetadataSidecarCommand, SidecarBinding, SidecarCommand } from "../shared/sidecar-contracts.ts";
import { SessionMetadataIndex } from "./session-metadata-index.ts";
import type { SidecarService } from "./sidecar-host.ts";

const CREATION_RESERVATION_GRACE_MS = 30_000;

export class MetadataWorkerService implements SidecarService {
  private readonly consumedColdLeaseNonces = new Map<string, number>();
  private readonly agentDir: string;
  private readonly index: SessionMetadataIndex;

  private constructor(agentDir: string, userDataDir: string) {
    this.agentDir = agentDir;
    this.index = new SessionMetadataIndex(userDataDir);
  }

  static async create(binding: SidecarBinding): Promise<{ service: MetadataWorkerService }> {
    if (binding.role !== "metadata") throw new Error(`Metadata worker received ${binding.role} binding`);
    return { service: new MetadataWorkerService(binding.value.agentDir, binding.value.userDataDir) };
  }

  async command(command: SidecarCommand): Promise<unknown> {
    return this.metadataCommand(command as MetadataSidecarCommand);
  }

  async dispose(): Promise<void> {}

  private async metadataCommand(command: MetadataSidecarCommand): Promise<unknown> {
    switch (command.type) {
      case "listSessions":
        return this.index.list(command.projectId, command.cwd);
      case "getDraftConfig": {
        const extensionSet = await validateResolvedExtensionSet(command.projectId, command.extensionSet);
        return loadDraftSessionConfig(command.cwd, undefined, this.agentDir, extensionSet);
      }
      case "resolveSession":
        return this.index.resolve(command.projectId, command.cwd, command.threadId);
      case "upsertSession":
        this.index.upsert(command.projectId, command.cwd, command.sessionFile, command.thread);
        return null;
      case "renameColdSession": {
        assertColdLease(command.projectId, command.threadId, "rename", command.lease, this.consumedColdLeaseNonces);
        const session = await this.index.resolve(command.projectId, command.cwd, command.threadId);
        const title = command.title.trim();
        SessionManager.open(session.path, undefined, command.cwd).appendSessionInfo(title);
        this.index.rename(command.projectId, command.cwd, command.threadId, title);
        return null;
      }
      case "removeColdSession": {
        assertColdLease(command.projectId, command.threadId, "remove", command.lease, this.consumedColdLeaseNonces);
        const session = await this.index.resolve(command.projectId, command.cwd, command.threadId);
        await rm(session.path);
        this.index.remove(command.projectId, command.threadId);
        return null;
      }
      case "recoverCreationReservation": {
        const { reservation } = command;
        if (
          reservation.state === "reserved" &&
          Number.isFinite(reservation.updatedAt) &&
          Date.now() - reservation.updatedAt < CREATION_RESERVATION_GRACE_MS
        ) {
          // Keep the main-to-worker hand-off window from being mistaken for an orphaned creation.
          return { status: "active" };
        }
        try {
          await this.index.resolve(reservation.projectId, reservation.cwd, reservation.sessionId);
          return { status: "committed" };
        } catch {
          const project = await this.index.rebuild(reservation.projectId, reservation.cwd);
          return { status: project.sessions.some(({ id }) => id === reservation.sessionId) ? "committed" : "orphan" };
        }
      }
      case "invalidateProject":
        this.index.invalidateProject(command.projectId);
        return null;
      case "ping":
        return { pong: true };
    }
  }
}

function assertColdLease(
  projectId: string,
  threadId: string,
  operation: "rename" | "remove",
  lease: { projectId: string; threadId: string; operation: "rename" | "remove"; nonce: string; expiresAt: number },
  consumedNonces: Map<string, number>,
): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt < now) consumedNonces.delete(nonce);
  }
  if (
    lease.projectId !== projectId ||
    lease.threadId !== threadId ||
    lease.operation !== operation ||
    !lease.nonce ||
    lease.expiresAt < now ||
    consumedNonces.has(lease.nonce)
  ) {
    throw new Error(`Invalid cold ${operation} lease for ${projectId}/${threadId}`);
  }
  consumedNonces.set(lease.nonce, lease.expiresAt);
}
