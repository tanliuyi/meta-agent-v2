import type { ImageInput, SessionBootstrap, SessionCreateInput, SessionIdentity } from "../../../shared/contracts.ts";
import type { DesktopApi } from "../../../shared/desktop-api.ts";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import type { SessionCacheController } from "./session-cache-context.tsx";

export function ensureDraftCreateRequestId(
  requestIds: Map<string, string>,
  projectId: string,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const existing = requestIds.get(projectId);
  if (existing) return existing;
  const created = createId();
  requestIds.set(projectId, created);
  return created;
}

interface DraftMaterializationInput {
  projectId: string;
  model: SessionCreateInput["model"];
  thinkingLevel: SessionCreateInput["thinkingLevel"];
  text: string;
  images: ImageInput[];
}

interface DraftMaterializationDependencies {
  requestIds: Map<string, string>;
  sessions: Pick<DesktopApi["sessions"], "create" | "prompt" | "remove">;
  cache: Pick<SessionCacheController, "ensureAttached" | "setActiveKey" | "retire">;
  onMaterialized(bootstrap: SessionBootstrap): void;
}

export interface DraftMaterializationResult {
  target: SessionIdentity;
  outcome: "accepted" | "unknown";
}

export async function materializeDraftSession(
  input: DraftMaterializationInput,
  dependencies: DraftMaterializationDependencies,
): Promise<DraftMaterializationResult> {
  const createRequestId = ensureDraftCreateRequestId(dependencies.requestIds, input.projectId);
  const bootstrap = await dependencies.sessions.create({
    projectId: input.projectId,
    createRequestId,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
  });
  dependencies.requestIds.delete(input.projectId);

  const target = { projectId: input.projectId, threadId: bootstrap.threadId };
  const recordKey = sessionRecordKey(target.projectId, target.threadId);
  try {
    const record = await dependencies.cache.ensureAttached(target);
    dependencies.cache.setActiveKey(record.key);
  } catch (error) {
    await cleanupMaterializedSession(dependencies, target, recordKey);
    throw error;
  }

  let result: Awaited<ReturnType<DesktopApi["sessions"]["prompt"]>>;
  try {
    result = await dependencies.sessions.prompt({
      requestId: crypto.randomUUID(),
      ...target,
      text: input.text,
      images: input.images,
    });
  } catch {
    dependencies.onMaterialized(bootstrap);
    return { target, outcome: "unknown" };
  }
  if (!result.accepted) {
    await cleanupMaterializedSession(dependencies, target, recordKey);
    throw new Error(result.error ?? "Pi 未接受此输入");
  }
  dependencies.onMaterialized(bootstrap);
  return { target, outcome: "accepted" };
}

async function cleanupMaterializedSession(
  dependencies: DraftMaterializationDependencies,
  target: SessionIdentity,
  recordKey: string,
): Promise<void> {
  await Promise.allSettled([
    dependencies.cache.retire(recordKey),
    dependencies.sessions.remove(target.projectId, target.threadId),
  ]);
}
