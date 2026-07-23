import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopExtensionSettingsService } from "../src/main/extensions/desktop-extension-settings-service.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../src/shared/desktop-extension-contracts.ts";

const directories: string[] = [];

describe("DesktopExtensionSettingsService", () => {
  let directory: string;
  let service: DesktopExtensionSettingsService;

  beforeEach(() => {
    directory = join(tmpdir(), `desktop-extensions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(directory);
    service = new DesktopExtensionSettingsService(directory, {
      createId: () => "entry-id",
      builtinDefinitions: [
        {
          id: "builtin",
          displayName: "Built in",
          source: "builtin",
          hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
          capabilities: ["tools.register"],
        },
      ],
      curatedDefinitions: [
        {
          id: "curated",
          displayName: "Curated",
          source: "curated",
          entryPath: "/bundled/curated.ts",
          hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
          capabilities: ["commands.register"],
        },
      ],
    });
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("defaults Developer Mode off and exposes release-locked entries", async () => {
    await expect(service.getConfig()).resolves.toMatchObject({
      developerMode: false,
      reloadRequired: false,
      entries: [
        { id: "builtin", source: "builtin", enabled: true },
        { id: "curated", source: "curated", enabled: true },
      ],
    });
  });

  it("does not rewrite settings or require reload for semantic no-op mutations", async () => {
    const before = await service.getConfig();

    const result = await service.saveConfig({
      requestId: "noop",
      expectedRevision: before.revision,
      mutation: { type: "set-developer-mode", enabled: false },
    });

    expect(result).toEqual({ status: "saved", snapshot: before });
    await expect(readFile(join(directory, "extensions.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("approves a main-selected regular file without exposing its path", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "local-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    const before = await service.getConfig();

    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: before.revision },
      entryPath,
    );

    expect(approved).toMatchObject({
      status: "saved",
      snapshot: {
        reloadRequired: true,
        entries: [
          { id: "builtin" },
          { id: "curated" },
          {
            id: "development:entry-id",
            source: "development",
            enabled: false,
            configuredEnabled: true,
            displayPath: "local-extension.ts",
          },
        ],
      },
    });
    expect(JSON.stringify(approved)).not.toContain(entryPath);
    expect(JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"))).toMatchObject({
      developmentEntries: [{ entryPath: await realpath(entryPath) }],
    });
  });

  it("persists curated enablement and removes development approvals", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "local-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    const before = await service.getConfig();
    const curated = await service.saveConfig({
      requestId: "disable-curated",
      expectedRevision: before.revision,
      mutation: { type: "set-curated-enabled", extensionId: "curated", enabled: false },
    });
    if (curated.status !== "saved") throw new Error("curated mutation failed");
    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-remove", expectedRevision: curated.snapshot.revision },
      entryPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");

    const removed = await service.saveConfig({
      requestId: "remove",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "remove-development-entry", extensionId: "development:entry-id" },
    });

    expect(removed).toMatchObject({
      status: "saved",
      snapshot: { entries: [{ id: "builtin" }, { id: "curated", configuredEnabled: false }] },
    });
    expect(JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"))).toMatchObject({
      curatedEnabled: { curated: false },
      developmentEntries: [],
    });
  });

  it("uses revision CAS and request IDs for idempotent mutations", async () => {
    const before = await service.getConfig();
    const input = {
      requestId: "toggle",
      expectedRevision: before.revision,
      mutation: { type: "set-developer-mode" as const, enabled: true },
    };

    const [first, second] = await Promise.all([service.saveConfig(input), service.saveConfig(input)]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "saved", snapshot: { developerMode: true } });
    await expect(
      service.saveConfig({
        requestId: "stale",
        expectedRevision: before.revision,
        mutation: { type: "set-developer-mode", enabled: false },
      }),
    ).resolves.toMatchObject({ status: "conflict" });
  });

  it("preserves unknown file keys and keeps generic restart state after mutations", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "extensions.json"),
      `${JSON.stringify({ version: 1, developerMode: false, future: { keep: true } }, null, 2)}\n`,
      "utf8",
    );
    const before = await service.getConfig();
    await service.saveConfig({
      requestId: "enable",
      expectedRevision: before.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    expect((await service.getConfig()).reloadRequired).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"))).toMatchObject({
      future: { keep: true },
    });
  });
});
