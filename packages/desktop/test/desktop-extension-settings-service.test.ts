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

  it("approves a plugin directory with a desktop-spec manifest using the manifest name and entry", async () => {
    const pluginDirectory = join(directory, "my-plugin");
    await mkdir(join(pluginDirectory, "payload"), { recursive: true });
    await writeFile(join(pluginDirectory, "payload", "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginDirectory, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.my-plugin", name: "My Plugin", version: "0.1.0", publisherId: "local" },
        pi: { entry: "payload/index.ts", extensionApi: "@earendil-works/pi-coding-agent" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["tools.register"],
      }),
      "utf8",
    );
    const before = await service.getConfig();

    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-directory", expectedRevision: before.revision },
      pluginDirectory,
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
            displayName: "My Plugin",
            source: "development",
            enabled: false,
            configuredEnabled: true,
            displayPath: "my-plugin",
          },
        ],
      },
    });
    expect(JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"))).toMatchObject({
      developmentEntries: [
        { displayName: "My Plugin", entryPath: await realpath(join(pluginDirectory, "payload", "index.ts")) },
      ],
    });
  });

  it("carries manifest capabilities and configuration schema into the snapshot", async () => {
    const pluginDirectory = join(directory, "configurable-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginDirectory, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.configurable", name: "Configurable", version: "0.1.0", publisherId: "local" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["configuration.read", "tools.register"],
        configuration: {
          version: 1,
          fields: [{ key: "endpoint", label: "Endpoint", type: "text", required: true }],
        },
      }),
      "utf8",
    );
    const before = await service.getConfig();

    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-configurable", expectedRevision: before.revision },
      pluginDirectory,
    );

    expect(approved.status).toBe("saved");
    if (approved.status !== "saved") throw new Error("approval failed");
    const entry = approved.snapshot.entries.find((candidate) => candidate.id === "development:entry-id");
    expect(entry).toMatchObject({
      capabilities: ["configuration.read", "tools.register"],
      configurationSchema: {
        version: 1,
        fields: [{ key: "endpoint", label: "Endpoint", type: "text", required: true }],
      },
    });
    await expect(service.getDevelopmentConfigurationSchema("development:entry-id")).resolves.toMatchObject({
      version: 1,
    });
    await expect(service.getDevelopmentConfigurationSchema("example.configurable")).resolves.toBeUndefined();
  });

  it("refreshes manifest metadata when an enabled development plugin is approved again", async () => {
    const pluginDirectory = join(directory, "refreshable-plugin");
    const manifestPath = join(pluginDirectory, "market-manifest.json");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.refreshable", name: "Before", version: "0.1.0", publisherId: "local" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["tools.register"],
      }),
      "utf8",
    );
    const before = await service.getConfig();
    const first = await service.approveDevelopmentEntry(
      { requestId: "approve-refreshable-first", expectedRevision: before.revision },
      pluginDirectory,
    );
    if (first.status !== "saved") throw new Error("first approval failed");

    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.refreshable", name: "After", version: "0.2.0", publisherId: "local" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["configuration.read"],
        configuration: {
          version: 1,
          fields: [{ key: "endpoint", label: "Endpoint", type: "text" }],
        },
      }),
      "utf8",
    );
    const refreshed = await service.approveDevelopmentEntry(
      { requestId: "approve-refreshable-second", expectedRevision: first.snapshot.revision },
      pluginDirectory,
    );

    expect(refreshed).toMatchObject({
      status: "saved",
      snapshot: {
        entries: [
          { id: "builtin" },
          { id: "curated" },
          {
            id: "development:entry-id",
            displayName: "After",
            configuredEnabled: true,
            capabilities: ["configuration.read"],
            configurationSchema: {
              version: 1,
              fields: [{ key: "endpoint", label: "Endpoint", type: "text" }],
            },
          },
        ],
      },
    });
  });

  it("rejects a manifest that declares configuration without the configuration.read capability", async () => {
    const pluginDirectory = join(directory, "bad-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginDirectory, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.bad", name: "Bad", version: "0.1.0", publisherId: "local" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["tools.register"],
        configuration: { version: 1, fields: [{ key: "endpoint", label: "Endpoint", type: "text" }] },
      }),
      "utf8",
    );
    const before = await service.getConfig();

    await expect(
      service.approveDevelopmentEntry({ requestId: "approve-bad", expectedRevision: before.revision }, pluginDirectory),
    ).rejects.toThrow("configuration requires the configuration.read capability");
  });

  it("approves a plugin directory without a manifest by resolving an index entry", async () => {
    const pluginDirectory = join(directory, "plain-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.mjs"), "export default function () {}\n", "utf8");
    const before = await service.getConfig();

    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-plain-directory", expectedRevision: before.revision },
      pluginDirectory,
    );

    expect(approved).toMatchObject({
      status: "saved",
      snapshot: {
        entries: [
          { id: "builtin" },
          { id: "curated" },
          {
            id: "development:entry-id",
            displayName: "plain-plugin",
            displayPath: "plain-plugin",
          },
        ],
      },
    });
  });

  it("rejects a plugin directory that is neither a desktop-spec plugin nor an index directory", async () => {
    const pluginDirectory = join(directory, "empty-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    const before = await service.getConfig();

    await expect(
      service.approveDevelopmentEntry(
        { requestId: "approve-empty", expectedRevision: before.revision },
        pluginDirectory,
      ),
    ).rejects.toThrow(/no market-manifest\.json or index entry file/);
  });

  it("rejects a plugin directory whose manifest host profile is incompatible", async () => {
    const pluginDirectory = join(directory, "old-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginDirectory, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.old", name: "Old Plugin", version: "0.1.0", publisherId: "local" },
        pi: { entry: "index.ts", extensionApi: "@earendil-works/pi-coding-agent" },
        desktop: { hostProfileVersion: 99 },
        capabilities: [],
      }),
      "utf8",
    );
    const before = await service.getConfig();

    await expect(
      service.approveDevelopmentEntry({ requestId: "approve-old", expectedRevision: before.revision }, pluginDirectory),
    ).rejects.toThrow(/host profile/);
  });

  it("rejects a plugin directory whose manifest entry is missing instead of falling back to index", async () => {
    const pluginDirectory = join(directory, "broken-plugin");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginDirectory, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "dev.broken", name: "Broken Plugin", version: "0.1.0", publisherId: "local" },
        pi: { entry: "payload/index.ts", extensionApi: "@earendil-works/pi-coding-agent" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: [],
      }),
      "utf8",
    );
    const before = await service.getConfig();

    await expect(
      service.approveDevelopmentEntry(
        { requestId: "approve-broken", expectedRevision: before.revision },
        pluginDirectory,
      ),
    ).rejects.toThrow(/pi\.entry file is missing/);
  });

  it("scopes a development plugin to selected projects and reverts to global", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "local-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-scope", expectedRevision: (await service.getConfig()).revision },
      entryPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");

    const scoped = await service.saveConfig({
      requestId: "scope",
      expectedRevision: approved.snapshot.revision,
      mutation: {
        type: "set-development-scope",
        extensionId: "development:entry-id",
        scope: "project",
        projectIds: ["project-a", "project-b", "project-a"],
      },
    });

    expect(scoped).toMatchObject({ status: "saved" });
    if (scoped.status !== "saved") throw new Error("scope mutation failed");
    expect(scoped.snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "development:entry-id",
          scope: "project",
          projectIds: ["project-a", "project-b"],
        }),
      ]),
    );
    expect(JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"))).toMatchObject({
      developmentEntries: [
        expect.objectContaining({
          id: "development:entry-id",
          scope: "project",
          projectIds: ["project-a", "project-b"],
        }),
      ],
    });

    const global = await service.saveConfig({
      requestId: "scope-global",
      expectedRevision: scoped.snapshot.revision,
      mutation: { type: "set-development-scope", extensionId: "development:entry-id", scope: "global" },
    });

    expect(global).toMatchObject({ status: "saved" });
    if (global.status !== "saved") throw new Error("scope mutation failed");
    expect(global.snapshot.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "development:entry-id", scope: "global" })]),
    );
    expect(global.snapshot.entries.find((entry) => entry.id === "development:entry-id")).not.toHaveProperty(
      "projectIds",
    );
  });

  it("rejects an invalid development scope mutation", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "local-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-scope-invalid", expectedRevision: (await service.getConfig()).revision },
      entryPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");

    await expect(
      service.saveConfig({
        requestId: "scope-empty",
        expectedRevision: approved.snapshot.revision,
        mutation: {
          type: "set-development-scope",
          extensionId: "development:entry-id",
          scope: "project",
          projectIds: [],
        },
      }),
    ).rejects.toThrow("at least one project");
    await expect(
      service.saveConfig({
        requestId: "scope-non-string",
        expectedRevision: approved.snapshot.revision,
        mutation: {
          type: "set-development-scope",
          extensionId: "development:entry-id",
          scope: "project",
          projectIds: [123] as unknown as string[],
        },
      }),
    ).rejects.toThrow("invalid project ID");
    await expect(
      service.saveConfig({
        requestId: "scope-unknown",
        expectedRevision: approved.snapshot.revision,
        mutation: { type: "set-development-scope", extensionId: "missing.plugin", scope: "global" },
      }),
    ).rejects.toThrow("Unknown development extension");
  });

  it("normalizes legacy development entries to global scope in snapshots", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "legacy-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    const approved = await service.approveDevelopmentEntry(
      { requestId: "approve-legacy", expectedRevision: (await service.getConfig()).revision },
      entryPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    const file = JSON.parse(await readFile(join(directory, "extensions.json"), "utf8"));
    delete file.developmentEntries[0].scope;
    await writeFile(join(directory, "extensions.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");

    const config = await service.getConfig();

    expect(config.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "development:entry-id", scope: "global" })]),
    );
    expect(config.entries.find((entry) => entry.id === "development:entry-id")).not.toHaveProperty("projectIds");
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

  it("loads legacy development entries without capabilities", async () => {
    await mkdir(directory, { recursive: true });
    const entryPath = join(directory, "legacy-extension.ts");
    await writeFile(entryPath, "export default function () {}\n", "utf8");
    await writeFile(
      join(directory, "extensions.json"),
      `${JSON.stringify(
        {
          version: 1,
          developerMode: true,
          curatedEnabled: {},
          developmentEntries: [
            {
              id: "development:legacy",
              displayName: "Legacy Extension",
              entryPath,
              enabled: true,
              displayPath: "legacy-extension.ts",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      developerMode: true,
      entries: [{ id: "builtin" }, { id: "curated" }, { id: "development:legacy", enabled: true, capabilities: [] }],
    });
    await expect(service.getInternalConfig()).resolves.toMatchObject({
      developmentEntries: [{ id: "development:legacy", capabilities: [] }],
    });
  });

  it("falls back to builtins when extension settings are invalid", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "extensions.json"),
      JSON.stringify({
        version: 1,
        developerMode: true,
        curatedEnabled: { curated: true },
        developmentEntries: [{ id: "development:broken", enabled: true }],
      }),
      "utf8",
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      developerMode: false,
      entries: [
        { id: "builtin", enabled: true },
        { id: "curated", enabled: false },
      ],
      diagnostics: [
        {
          code: "DESKTOP_EXTENSION_SETTINGS_INVALID",
          message: "extensions.json development entry is invalid",
        },
      ],
    });
    await expect(service.getInternalConfig()).resolves.toMatchObject({
      developerMode: false,
      curatedEnabled: { curated: false },
      developmentEntries: [],
    });
  });
});
