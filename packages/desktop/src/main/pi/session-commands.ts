import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "../../shared/contracts.ts";

type CommandSession = Pick<AgentSession, "extensionRunner" | "promptTemplates" | "resourceLoader">;

/** 从 Pi session 的真实资源生成 Composer slash command。 */
export function getSessionCommands(session: CommandSession): SlashCommand[] {
  const extensions = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    source: "extension" as const,
  }));
  const prompts = session.promptTemplates.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    source: "prompt" as const,
  }));
  const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
  }));
  return [...extensions, ...prompts, ...skills];
}

/** 从尚未 materialize 的 Pi resources 生成 draft Composer 命令。 */
export function getDraftCommands(resourceLoader: ResourceLoader): SlashCommand[] {
  const registered = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.commands.values()]);
  const counts = new Map<string, number>();
  for (const command of registered) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  const extensions = registered.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1;
    seen.set(command.name, occurrence);
    let name = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
    if (taken.has(name)) {
      let suffix = occurrence;
      do {
        suffix += 1;
        name = `${command.name}:${suffix}`;
      } while (taken.has(name));
    }
    taken.add(name);
    return { name, description: command.description, source: "extension" as const };
  });
  const prompts = resourceLoader.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    source: "prompt" as const,
  }));
  const skills = resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
  }));
  return [...extensions, ...prompts, ...skills];
}
