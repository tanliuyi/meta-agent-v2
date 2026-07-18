import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop Pi resources", () => {
  it("通过 Pi services 发现 agentDir 中的全局 extension 与 skill", async () => {
    const root = join(tmpdir(), `desktop-pi-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    tempDirs.push(root);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(agentDir, "skills", "global-review"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "global-command.ts"),
      'export default function (pi) { pi.registerCommand("global-command", { description: "global command", handler() {} }); }\n',
    );
    await writeFile(
      join(agentDir, "skills", "global-review", "SKILL.md"),
      "---\nname: global-review\ndescription: Review code from the global skill directory.\n---\n\n# Global Review\n",
    );

    const services = await createAgentSessionServices({ cwd, agentDir });

    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    expect(services.resourceLoader.getExtensions().extensions).toHaveLength(1);
    expect(services.resourceLoader.getExtensions().extensions[0]?.commands.has("global-command")).toBe(true);
    expect(services.resourceLoader.getSkills().skills.map(({ name }) => name)).toContain("global-review");
  });
});
