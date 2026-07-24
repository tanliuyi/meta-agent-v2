import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../store/skill-store.ts";
import type { SkillIndex } from "../types.ts";

interface SkillCommandInfo {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readLoadedSkills(owner: unknown): SkillCommandInfo[] {
  try {
    if (!isRecord(owner) || typeof owner.getCommands !== "function") return [];
    const commands: unknown = owner.getCommands();
    if (!Array.isArray(commands)) return [];
    return commands.filter((command): command is SkillCommandInfo => {
      if (!isRecord(command)) return false;
      return typeof command.name === "string" && command.source === "skill";
    });
  } catch {
    return [];
  }
}

function managedSkillLines(skills: SkillIndex[], projectName: string | null): string[] {
  if (skills.length === 0) return [];
  const lines = ["Managed skills:"];
  for (const skill of skills) {
    const scope = skill.scope === "global" ? "global" : `project:${projectName ?? "unknown"}`;
    lines.push(`- [${scope}] ${skill.displayName || skill.name}: ${skill.description || "(no description)"}`);
  }
  return lines;
}

function externalSkillLines(commands: SkillCommandInfo[], managed: SkillIndex[]): string[] {
  const managedPaths = new Set(managed.map((skill) => path.resolve(skill.path)));
  const seen = new Set<string>();
  const external = commands.filter((command) => {
    const sourcePath = command.sourceInfo?.path;
    if (!sourcePath) return false;
    const normalized = path.resolve(sourcePath);
    if (managedPaths.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (external.length === 0) return [];
  return [
    "Loaded external skills (read-only):",
    ...external.map(
      (command) => `- ${command.name.replace(/^skill:/, "")}: ${command.description || "(no description)"}`,
    ),
  ];
}

/** Desktop Host Profile has no custom TUI surface; skill mutations remain available through skill_manage. */
export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "List managed and loaded procedural skills",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const managed = await store.loadIndex();
      const loaded = readLoadedSkills(pi);
      const sections = [...managedSkillLines(managed, store.getProjectName()), ...externalSkillLines(loaded, managed)];
      ctx.ui.notify(
        sections.length > 0
          ? sections.join("\n")
          : "No skills found. Use the skill_manage tool to create a reusable procedure.",
        "info",
      );
    },
  });
}
