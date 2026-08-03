import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useEffect, useMemo, useState } from "react";
import type { Project, Thread } from "../../../../shared/contracts.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjects } from "../../state/desktop-selectors.ts";
import { useThreadPinning } from "../../state/thread-pinning-context.tsx";
import { pinnedThreadKey, pinnedThreadProjectIds } from "../../state/thread-pinning-preference.ts";
import { DesktopThreadList } from "./desktop-thread-list.tsx";

interface PinnedConversationGroup {
  project: Project;
  threads: readonly Thread[];
  pinnedThreads: readonly Thread[];
}

export interface PinnedCatalogLoadPlan {
  /** 需要加载 catalog 的置顶项目。 */
  needsLoad: string[];
  /** 存在仍在加载中（未失败）的置顶项目。 */
  waiting: boolean;
  /** 存在加载失败的置顶项目。 */
  failed: boolean;
}

/** 置顶项目的 catalog 加载计划：失败项目不再计入等待，必须有明确重试入口。 */
export function planPinnedCatalogLoads(
  projects: readonly Project[],
  pinnedProjectIds: ReadonlySet<string>,
  threadCatalogs: Readonly<Record<string, Thread[] | undefined>>,
  failedProjectIds: ReadonlySet<string>,
): PinnedCatalogLoadPlan {
  const needsLoad = projects
    .filter(
      (project) => project.available && pinnedProjectIds.has(project.id) && threadCatalogs[project.id] === undefined,
    )
    .map(({ id }) => id);
  return {
    needsLoad,
    waiting: needsLoad.some((id) => !failedProjectIds.has(id)),
    failed: needsLoad.some((id) => failedProjectIds.has(id)),
  };
}

/** 侧栏顶部的跨 Project 置顶会话分组。 */
export function PinnedConversationSection() {
  const actions = useDesktopActions();
  const projects = useDesktopSelector(selectProjects);
  const threadCatalogs = useDesktopSelector((state) => state.threadCatalogs);
  const { pinnedThreadKeys } = useThreadPinning();
  const pinnedProjectIds = useMemo(() => pinnedThreadProjectIds(pinnedThreadKeys), [pinnedThreadKeys]);
  const [failedProjectIds, setFailedProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryNonce, setRetryNonce] = useState(0);

  const loadPlan = useMemo(
    () => planPinnedCatalogLoads(projects, pinnedProjectIds, threadCatalogs, failedProjectIds),
    [failedProjectIds, pinnedProjectIds, projects, threadCatalogs],
  );

  useEffect(() => {
    let cancelled = false;
    // 加载成功后清除失败标记，避免失败状态残留。
    setFailedProjectIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of next) {
        if (threadCatalogs[id] !== undefined) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    for (const projectId of loadPlan.needsLoad) {
      if (failedProjectIds.has(projectId)) continue;
      void actions.loadProjectThreads(projectId).catch(() => {
        if (cancelled) return;
        setFailedProjectIds((current) => (current.has(projectId) ? current : new Set(current).add(projectId)));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [actions, loadPlan, retryNonce, threadCatalogs]);

  const groups = useMemo<PinnedConversationGroup[]>(
    () =>
      projects.flatMap((project) => {
        const threads = threadCatalogs[project.id];
        if (!threads) return [];
        const pinnedThreads = threads.filter(
          (thread) => !thread.archived && pinnedThreadKeys.has(pinnedThreadKey(thread.projectId, thread.id)),
        );
        return pinnedThreads.length > 0 ? [{ project, threads, pinnedThreads }] : [];
      }),
    [pinnedThreadKeys, projects, threadCatalogs],
  );
  const failedProjects = projects.filter(
    (project) => failedProjectIds.has(project.id) && threadCatalogs[project.id] === undefined,
  );

  if (groups.length === 0 && !loadPlan.waiting && failedProjects.length === 0) return null;

  return (
    <section className="sidebar-pinned-section mt-3" aria-labelledby="sidebar-pinned-heading">
      <div className="sidebar-section-heading">
        <span id="sidebar-pinned-heading">置顶</span>
      </div>
      <div className="sidebar-projects sidebar-pinned-groups">
        {groups.map(({ project, threads, pinnedThreads }) => (
          <div key={project.id} className="sidebar-pinned-group">
            <div className="px-2 text-xs text-muted-foreground">{project.name}</div>
            <DesktopThreadList
              project={project}
              threads={threads}
              displayThreads={pinnedThreads}
              displayMode="keep"
              compactRoot
            />
          </div>
        ))}
        {loadPlan.waiting ? (
          <div className="flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            <span>加载置顶会话</span>
          </div>
        ) : null}
        {failedProjects.length > 0 ? (
          <div className="flex h-8 items-center gap-2 px-2 text-sm text-destructive" role="alert">
            <span>置顶会话加载失败</span>
            <button
              type="button"
              className="flex items-center gap-1 underline-offset-2 hover:underline"
              onClick={() => {
                setRetryNonce((nonce) => nonce + 1);
                setFailedProjectIds(new Set());
              }}
            >
              <RefreshCw className="size-3" aria-hidden="true" />
              重试
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
