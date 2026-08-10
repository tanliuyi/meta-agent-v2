import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateResolvedExtensionSet } from "../main/pi/desktop-extension-runtime-policy.ts";
import { loadDraftSessionConfig } from "../main/pi/session-configuration.ts";
import type {
  ColdOperationLease,
  MetadataSidecarCommand,
  SidecarBinding,
  SidecarCommand,
} from "../shared/sidecar-contracts.ts";
import { SessionMetadataIndex, type SessionRemovalPlan } from "./session-metadata-index.ts";
import type { SidecarService } from "./sidecar-host.ts";

const CREATION_RESERVATION_GRACE_MS = 30_000;

export class MetadataWorkerService implements SidecarService {
  private readonly consumedColdLeaseNonces = new Map<string, number>();
  private readonly agentDir: string;
  private readonly index: SessionMetadataIndex;
  private readonly removalJournalDir: string;

  private constructor(agentDir: string, userDataDir: string) {
    this.agentDir = agentDir;
    this.index = new SessionMetadataIndex(userDataDir, agentDir);
    this.removalJournalDir = join(userDataDir, "session-removal-journals");
  }

  static async create(binding: SidecarBinding): Promise<{ service: MetadataWorkerService }> {
    if (binding.role !== "metadata") throw new Error(`Metadata worker received ${binding.role} binding`);
    const service = new MetadataWorkerService(binding.value.agentDir, binding.value.userDataDir);
    await service.recoverPendingRemovals();
    return { service };
  }

  async command(command: SidecarCommand): Promise<unknown> {
    return this.metadataCommand(command as MetadataSidecarCommand);
  }

  async dispose(): Promise<void> {}

  private async metadataCommand(command: MetadataSidecarCommand): Promise<unknown> {
    switch (command.type) {
      case "listSessions":
        return this.index.list(command.projectId, command.cwd);
      case "listSessionsWithPaths":
        return this.index.listWithPaths(command.projectId, command.cwd);
      case "getDraftConfig": {
        const extensionSet = await validateResolvedExtensionSet(command.projectId, command.extensionSet);
        return loadDraftSessionConfig(command.cwd, undefined, this.agentDir, extensionSet, command.allEntries);
      }
      case "resolveSession":
        return this.index.resolve(command.projectId, command.cwd, command.threadId);
      case "upsertSession":
        this.index.upsert(command.projectId, command.cwd, command.sessionFile, command.thread);
        return null;
      case "registerExternalSession":
        this.index.registerExternalSession(command.projectId, command.cwd, command.sessionFile, command.thread);
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
        if (command.policy !== "subtree" && command.policy !== "reparent") {
          throw new Error(`Invalid session removal policy: ${command.policy}`);
        }
        const plan = await this.index.planRemoval(command.projectId, command.cwd, command.threadId, command.policy);
        return commitSessionRemoval(this.index, plan, this.removalJournalDir);
      }
      case "promoteColdSession": {
        assertColdLease(command.projectId, command.threadId, "promote", command.lease, this.consumedColdLeaseNonces);
        const plan = await this.index.planPromotion(command.projectId, command.cwd, command.threadId);
        return commitSessionRemoval(this.index, plan, this.removalJournalDir);
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
  private async recoverPendingRemovals(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.removalJournalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const journalPath = join(this.removalJournalDir, name);
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as RemovalJournal;
      if (this.index.isRemovalApplied(journal.plan)) await finalizeCommittedRemoval(journal);
      else await rollbackRemoval(journal);
      await rm(journalPath, { force: true });
    }
  }
}

interface StagedRewrite {
  path: string;
  temporaryPath: string;
  backupPath: string;
}

interface RemovalJournal {
  plan: SessionRemovalPlan;
  removals: Array<{ path: string; tombstonePath: string }>;
  rewrites: StagedRewrite[];
}

async function commitSessionRemoval(index: SessionMetadataIndex, plan: SessionRemovalPlan, journalDir: string) {
  const nonce = `${process.pid}.${randomUUID()}`;
  const rewrites: StagedRewrite[] = plan.reparentedSessions.map(({ session }) => ({
    path: session.path,
    temporaryPath: `${session.path}.${nonce}.reparent`,
    backupPath: `${session.path}.${nonce}.backup`,
  }));
  const journal: RemovalJournal = {
    plan,
    removals: plan.removedSessions.map(({ path }) => ({ path, tombstonePath: `${path}.${nonce}.deleted` })),
    rewrites,
  };
  const journalPath = join(journalDir, `${nonce}.json`);
  const temporaryJournalPath = `${journalPath}.tmp`;
  try {
    await mkdir(journalDir, { recursive: true });
    await writeFile(temporaryJournalPath, `${JSON.stringify(journal)}\n`, { flag: "wx" });
    await rename(temporaryJournalPath, journalPath);
  } catch (error) {
    try {
      await rm(temporaryJournalPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Session removal journal publication failed during cleanup");
    }
    throw error;
  }
  let committed = false;
  try {
    for (const [
      index,
      { session, previousParentPath, nextParentPath, promoteToRoot },
    ] of plan.reparentedSessions.entries()) {
      const rewrite = rewrites[index];
      if (!rewrite) throw new Error(`Session removal journal is missing rewrite ${session.id}`);
      await stageParentRewrite(session.path, previousParentPath, nextParentPath, rewrite, promoteToRoot === true);
    }
    for (const removal of journal.removals) await rename(removal.path, removal.tombstonePath);
    for (const rewrite of rewrites) {
      if (!(await pathExists(rewrite.temporaryPath))) continue;
      await rename(rewrite.path, rewrite.backupPath);
      await rename(rewrite.temporaryPath, rewrite.path);
    }
    const result = index.applyRemoval(plan);
    committed = true;
    try {
      await finalizeCommittedRemoval(journal);
      await rm(journalPath, { force: true });
    } catch {
      // The committed index is authoritative; startup recovery will finish cleanup from the journal.
    }
    return result;
  } catch (error) {
    if (committed) return plan.result;
    try {
      await rollbackRemoval(journal);
      await rm(journalPath, { force: true });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Session tree removal failed and rollback requires recovery");
    }
    throw error;
  }
}

async function finalizeCommittedRemoval(journal: RemovalJournal): Promise<void> {
  for (const rewrite of journal.rewrites) {
    const temporaryExists = await pathExists(rewrite.temporaryPath);
    const backupExists = await pathExists(rewrite.backupPath);
    if (temporaryExists) {
      if (await pathExists(rewrite.path)) {
        if (!backupExists) await rename(rewrite.path, rewrite.backupPath);
        else await rm(rewrite.path, { force: true });
      }
      await rename(rewrite.temporaryPath, rewrite.path);
    }
    await rm(rewrite.backupPath, { force: true });
  }
  for (const removal of journal.removals) {
    if (await pathExists(removal.path)) {
      if (await pathExists(removal.tombstonePath)) await rm(removal.path, { force: true });
      else await rename(removal.path, removal.tombstonePath);
    }
    await rm(removal.tombstonePath, { force: true });
  }
}

async function rollbackRemoval(journal: RemovalJournal): Promise<void> {
  for (const rewrite of [...journal.rewrites].reverse()) {
    if (await pathExists(rewrite.backupPath)) {
      await rm(rewrite.path, { force: true });
      await rename(rewrite.backupPath, rewrite.path);
    }
    await rm(rewrite.temporaryPath, { force: true });
  }
  for (const removal of [...journal.removals].reverse()) {
    if (!(await pathExists(removal.tombstonePath))) continue;
    if (await pathExists(removal.path)) {
      throw new Error(`Cannot restore session file because its path is occupied: ${removal.path}`);
    }
    await rename(removal.tombstonePath, removal.path);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function stageParentRewrite(
  sessionFile: string,
  previousParentPath: string,
  nextParentPath: string | undefined,
  rewrite: StagedRewrite,
  promoteToRoot = false,
): Promise<void> {
  const content = await readFile(sessionFile, "utf8");
  const newline = content.indexOf("\n");
  const headerText = newline === -1 ? content : content.slice(0, newline);
  let header: unknown;
  try {
    header = JSON.parse(headerText);
  } catch (error) {
    throw new Error(`Cannot reparent invalid Pi session header: ${sessionFile}`, { cause: error });
  }
  if (!isRecord(header) || header.type !== "session") {
    throw new Error(`Cannot reparent non-session file: ${sessionFile}`);
  }
  const currentParent = typeof header.parentSession === "string" ? header.parentSession : undefined;
  if (currentParent && resolve(currentParent) !== resolve(previousParentPath)) {
    throw new Error(`Pi session parent changed while reparenting: ${sessionFile}`);
  }
  if (!currentParent && !nextParentPath && !promoteToRoot) return;
  if (nextParentPath) header.parentSession = nextParentPath;
  else delete header.parentSession;
  if (promoteToRoot) header.promotedRoot = true;
  const remainder = newline === -1 ? "" : content.slice(newline);
  await writeFile(rewrite.temporaryPath, `${JSON.stringify(header)}${remainder}`, { flag: "wx" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertColdLease(
  projectId: string,
  threadId: string,
  operation: ColdOperationLease["operation"],
  lease: {
    projectId: string;
    threadId: string;
    operation: "rename" | "remove" | "promote";
    nonce: string;
    expiresAt: number;
  },
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
