import type {
  DraftSessionConfig,
  ImageInput,
  SessionBootstrap,
  SessionCreateInput,
  SessionIdentity,
  ThinkingLevel,
} from "../../../shared/contracts.ts";
import type { DesktopApi } from "../../../shared/desktop-api.ts";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import type { SessionCacheController } from "./session-cache-context.tsx";

/** 选中草稿模型：同步 thinking 级别与 readiness；模型不存在时保持不变。 */
export function selectDraftModel(
  config: DraftSessionConfig | null,
  provider: string,
  modelId: string,
): DraftSessionConfig | null {
  const model = config?.models.find((entry) => entry.provider === provider && entry.id === modelId);
  if (!config || !model) return config;
  const thinkingLevel = model.thinkingLevels.includes(config.thinkingLevel)
    ? config.thinkingLevel
    : (model.thinkingLevels[0] ?? "off");
  return {
    ...config,
    model: { provider: model.provider, id: model.id, name: model.name },
    thinkingLevel,
    thinkingLevels: model.thinkingLevels,
    readiness: { state: "ready" },
  };
}

/** 选中草稿 thinking 级别；模型不支持该级别时保持不变。 */
export function selectDraftThinkingLevel(
  config: DraftSessionConfig | null,
  thinkingLevel: ThinkingLevel,
): DraftSessionConfig | null {
  return config?.thinkingLevels.includes(thinkingLevel) ? { ...config, thinkingLevel } : config;
}

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
  extensionSetGeneration: string;
  /** 创建为该会话的子会话（侧边栏草稿等场景）。 */
  parentThreadId?: string;
  text: string;
  images: ImageInput[];
}

interface DraftMaterializationDependencies {
  requestIds: Map<string, string>;
  sessions: Pick<DesktopApi["sessions"], "create" | "prompt" | "remove">;
  cache: Pick<SessionCacheController, "ensureAttached" | "retire">;
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
    extensionSetGeneration: input.extensionSetGeneration,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
  });
  dependencies.requestIds.delete(input.projectId);

  const target = { projectId: input.projectId, threadId: bootstrap.threadId };
  const recordKey = sessionRecordKey(target.projectId, target.threadId);
  try {
    await dependencies.cache.ensureAttached(target);
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
    dependencies.sessions.remove(target.projectId, target.threadId, "subtree"),
  ]);
}

/** 草稿提交因扩展集过期被拒时的判定。 */
export function isStaleExtensionSetError(reason: unknown): boolean {
  return (
    (reason instanceof Error && reason.message.includes("Draft extension set changed")) ||
    (typeof reason === "object" && reason !== null && "code" in reason && reason.code === "STALE_DRAFT_EXTENSION_SET")
  );
}
