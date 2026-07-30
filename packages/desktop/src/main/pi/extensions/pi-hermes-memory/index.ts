/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. Conversational Memory Commands — interview, guidance, and manual consolidation
 * 9. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 10. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { isDatabaseMigrationPending } from "./extension-root-migration.ts";
import { registerConsolidateCommand, triggerConsolidation } from "./handlers/auto-consolidate.ts";
import { setupBackgroundReview } from "./handlers/background-review.ts";
import { setupCorrectionDetector } from "./handlers/correction-detector.ts";
import { registerInterviewCommand } from "./handlers/interview.ts";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.ts";
import {
  SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS,
  scheduleSessionBackfill,
  waitForSessionBackfill,
} from "./handlers/session-backfill.ts";
import { setupSessionFlush } from "./handlers/session-flush.ts";
import {
  SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS,
  scheduleLiveSessionIndex,
  waitForLiveSessionIndex,
} from "./handlers/session-live-index.ts";
import { migrateThenSyncMarkdownMemories } from "./handlers/sync-markdown-memories.ts";
import { AGENT_ROOT, resolveGlobalMemoryRoot } from "./paths.ts";
import { detectProject, detectProjectSkills } from "./project.ts";
import { migrateLegacyProjectMemoryDirs } from "./project-memory-migration.ts";
import { buildPromptContext } from "./prompt-context.ts";
import { DatabaseManager } from "./store/db.ts";
import { MemoryStore } from "./store/memory-store.ts";
import { indexSession, upsertSessionFileMetadata } from "./store/session-indexer.ts";
import { parseSessionFile } from "./store/session-parser.ts";
import { SkillStore } from "./store/skill-store.ts";
import { registerMemorySearchTool } from "./tools/memory-search-tool.ts";
import { registerMemoryTool } from "./tools/memory-tool.ts";
import { registerSessionSearchTool } from "./tools/session-search-tool.ts";
import { registerSkillTool } from "./tools/skill-tool.ts";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);

  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) => {
    return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
  });
}

export interface HermesMemoryExtensionOptions {
  disableChildProcesses?: boolean;
  programmaticSubagent?: boolean;
}

export default function (pi: ExtensionAPI, options: HermesMemoryExtensionOptions = {}) {
  const config = {
    ...loadConfig(),
    ...(options.disableChildProcesses || options.programmaticSubagent ? { childProcessDisabled: true } : {}),
    ...(options.programmaticSubagent
      ? {
          reviewEnabled: false,
          flushOnCompact: false,
          flushOnShutdown: false,
          correctionDetection: false,
        }
      : {}),
  };

  const agentRoot = AGENT_ROOT;
  const { globalDir, legacyGlobalDir, shouldMigrateLegacyRoot } = resolveGlobalMemoryRoot(config.memoryDir, agentRoot);
  let persistenceInitialized = false;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
    projectName: project.name,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    legacyPiGlobalSkillsDir: path.join(agentRoot, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);
  let databaseMigrationPending = shouldMigrateLegacyRoot && isDatabaseMigrationPending(legacyGlobalDir, globalDir);
  if (databaseMigrationPending) {
    dbManager.setOpenGuard(() => {
      if (databaseMigrationPending) {
        throw new Error("Legacy sessions.db migration is pending");
      }
    });
  }
  const sessionsDir = path.join(agentRoot, "sessions");

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Keep project memory available for users upgrading from the old
  // ~/.pi-desk/agent/<project>/ layout. This is non-destructive: legacy folders
  // remain in place while entries are copied/merged into projects-memory/.
  migrateLegacyProjectMemoryDirs(agentRoot, config.projectsMemoryDir);
  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.pi-desk/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;

  // ── 1. Load memory from disk on session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!persistenceInitialized) {
      try {
        await migrateThenSyncMarkdownMemories(
          dbManager,
          shouldMigrateLegacyRoot ? legacyGlobalDir : null,
          globalDir,
          config.projectsMemoryDir,
          agentRoot,
          {
            onMigrationSucceeded: () => {
              databaseMigrationPending = false;
              dbManager.setOpenGuard(null);
            },
          },
        );
        persistenceInitialized = true;
      } catch {
        // Best-effort only: migration or SQLite backfill must not block startup.
      }
    }

    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();

    if (persistenceInitialized)
      scheduleSessionBackfill(dbManager, sessionsDir, {
        notify: (message, level) => {
          const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) {
            ui.notify(message, level);
          } else if (level === "error" || level === "warning") {
            console.warn(message);
          } else {
            console.info(message);
          }
        },
      });
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject memory policy by default; legacy mode keeps full frozen memory blocks ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const promptContext = await buildPromptContext(config, store, projectStore, projectName);

    if (promptContext) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${promptContext}`,
      };
    }
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config, {
    dbManager,
    projectName: projectName || null,
  });

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStore, config, dbManager, projectName);

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(pi, store, target, signal, config.consolidationTimeoutMs, target, config);
  });
  if (projectStore) {
    projectStore.setConsolidator(async (target, signal) => {
      const toolTarget = target === "memory" ? "project" : target;
      return triggerConsolidation(pi, projectStore, target, signal, config.consolidationTimeoutMs, toolTarget, config);
    });
  }
  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStore, config, dbManager, projectName);

  // Desktop Settings owns structured management. Conversational and model-driven
  // flows remain slash commands because they operate naturally inside a session.
  registerInterviewCommand(pi, store);
  registerLearnMemoryCommand(pi);
  registerConsolidateCommand(pi, store, config.consolidationTimeoutMs, projectStore, projectName, config, dbManager);

  // ── 9. Live session indexing ──
  pi.on("message_end", async (_event, ctx) => {
    scheduleLiveSessionIndex(dbManager, ctx.sessionManager, {
      onError: (err) =>
        console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });

  // ── 10. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager);

  // ── 11. Auto-index session on shutdown ──
  // Registered last, so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && fs.existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          dbManager.withCorruptionRecovery(() => {
            indexSession(dbManager, sessionData);
            // Keep session_files metadata in sync with the final on-disk state.
            // Pi appends the closing session entry on shutdown after the last
            // message_end, so without this upsert the stored size/mtime would be
            // stale and the next startup would re-parse this file unnecessarily.
            upsertSessionFileMetadata(dbManager, sessionFile, sessionData.id);
          });
        }
      }
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try {
        await Promise.all([
          waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
          waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        ]);
      } catch {
        // Best effort only — shutdown should not be held up by indexing errors.
      }
      try {
        dbManager.close();
      } catch {
        /* best effort — never block shutdown */
      }
    }
  });
}
