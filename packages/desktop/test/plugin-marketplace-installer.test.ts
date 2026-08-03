import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplacePluginInstaller } from "../src/main/plugins/marketplace-plugin-installer.ts";
import { MarketplacePluginRegistry } from "../src/main/plugins/marketplace-plugin-registry.ts";
import type { RuntimeCompatibility } from "../src/shared/sidecar-contracts.ts";

const runtime: RuntimeCompatibility = {
  nodeVersion: "22.22.1",
  modulesAbi: "127",
  napi: "10",
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.6.0",
  libc: "none",
  toolchain: "electron-node-v1",
  piVersion: "0.80.7",
  runtimeCompatibilityId: "runtime-1",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplacePluginInstaller", () => {
  it("installs an artifact using an immutable Pi extension projection", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();

    const result = await harness.installer.install({
      requestId: "install-1",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });

    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("Expected installation to succeed");
    expect(result.snapshot.plugins).toEqual([
      expect.objectContaining({
        id: "dev.meta-agent.example-tools",
        version: "1.0.0",
        capabilities: ["tools.register", "configuration.read"],
        containsNativeCode: false,
        configurable: true,
        enabled: true,
      }),
    ]);
    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(
      expect.objectContaining({
        plugins: [
          expect.objectContaining({
            artifactHash: harness.artifactHash,
            configurationSchema: expect.objectContaining({ version: 1 }),
          }),
        ],
      }),
    );
    const root = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    const installedEntry = join(root, ".versions", harness.artifactHash, "payload", "index.ts");
    await expect(readFile(installedEntry, "utf8")).resolves.toContain("pi.registerTool");
    await expect(readFile(join(root, "index.ts"), "utf8")).resolves.toBe(
      `export { default } from ${JSON.stringify(`./.versions/${harness.artifactHash}/payload/index.ts`)};\n`,
    );

    const restarted = new MarketplacePluginInstaller(
      harness.endpoints as never,
      new MarketplacePluginRegistry(harness.userDataDir),
      join(harness.userDataDir, "plugins", "locks"),
      harness.agentDir,
      "0.0.31",
      runtime,
      { fetch: vi.fn() },
    );
    const repeated = await restarted.install({
      requestId: "install-2",
      expectedRevision: result.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    expect(repeated.status).toBe("already-installed");
  });

  it("omits empty runtime compatibility values from artifact requests", async () => {
    const harness = await createHarness({ runtimeCompatibility: { ...runtime, toolchain: "" } });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-empty-toolchain",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    const artifactRequest = harness.fetchImpl.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
      .find((url) => url.pathname.endsWith("/artifacts"));
    expect(artifactRequest?.searchParams.has("toolchain")).toBe(false);
  });

  it("rejects a configurable artifact without configuration.read", async () => {
    const harness = await createHarness({ omitConfigurationCapability: true });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-missing-config-capability",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("configuration requires configuration.read capability");
  });

  it("completes the install before immediate apply", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();

    const result = await harness.installer.install({
      requestId: "install-for-apply",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    });

    expect(result.status).toBe("installed");
  });

  it("updates and downgrades by switching immutable versions without deleting the previous version", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const installed = await harness.installer.install({
      requestId: "install-before-update",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") throw new Error("Expected installation to succeed");
    const updateEndpoint = vi.fn(async () => harness.endpoint);
    harness.endpoints.getActiveEndpoint.mockImplementation(updateEndpoint);

    const updated = await harness.installer.update({
      requestId: "update-to-2",
      expectedRevision: installed.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "2.0.0",
      confirmFullTrust: true,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        status: "updated",
        reloadRequired: true,
        snapshot: expect.objectContaining({
          plugins: [expect.objectContaining({ version: "2.0.0" })],
        }),
      }),
    );
    expect(updateEndpoint).toHaveBeenCalled();
    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await expect(
      readFile(join(pluginRoot, ".versions", harness.artifactHash, "payload", "index.ts"), "utf8"),
    ).resolves.toContain("example-1.0.0");
    await expect(
      readFile(join(pluginRoot, ".versions", harness.updateArtifactHash, "payload", "index.ts"), "utf8"),
    ).resolves.toContain("example-2.0.0");
    await expect(readFile(join(pluginRoot, "index.ts"), "utf8")).resolves.toContain(harness.updateArtifactHash);

    if (updated.status !== "updated") throw new Error("Expected update to succeed");
    const downgraded = await harness.installer.update({
      requestId: "downgrade-to-1",
      expectedRevision: updated.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    expect(downgraded).toEqual(
      expect.objectContaining({
        status: "updated",
        snapshot: expect.objectContaining({ plugins: [expect.objectContaining({ version: "1.0.0" })] }),
      }),
    );
    await expect(readFile(join(pluginRoot, "index.ts"), "utf8")).resolves.toContain(harness.artifactHash);
  });

  it("uninstalls through the registry commit point while retaining immutable files", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const installed = await harness.installer.install({
      requestId: "install-before-uninstall",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") throw new Error("Expected installation to succeed");

    const result = await harness.installer.uninstall({
      requestId: "uninstall-1",
      expectedRevision: installed.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      confirmRemoval: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "uninstalled",
        reloadRequired: true,
        snapshot: expect.objectContaining({ plugins: [] }),
      }),
    );
    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await expect(readFile(join(pluginRoot, "index.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(pluginRoot, ".meta-agent-market.json"), "utf8")).resolves.toContain(
      '"state": "uninstalled"',
    );
    await expect(
      readFile(join(pluginRoot, ".versions", harness.artifactHash, "payload", "index.ts"), "utf8"),
    ).resolves.toContain("pi.registerTool");

    if (result.status !== "uninstalled") throw new Error("Expected uninstall to succeed");
    const reinstalled = await harness.installer.install({
      requestId: "reinstall-1",
      expectedRevision: result.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    expect(reinstalled.status).toBe("installed");
    await expect(readFile(join(pluginRoot, "index.ts"), "utf8")).resolves.toContain(
      `./.versions/${harness.artifactHash}/payload/index.ts`,
    );
  });

  it("uninstalls a managed version without treating same-user edits as protected state", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const installed = await harness.installer.install({
      requestId: "install-before-modification",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") throw new Error("Expected installation to succeed");
    const entry = join(
      harness.agentDir,
      "extensions",
      "dev.meta-agent.example-tools",
      ".versions",
      harness.artifactHash,
      "payload",
      "index.ts",
    );
    await writeFile(entry, "modified\n", "utf8");

    const result = await harness.installer.uninstall({
      requestId: "uninstall-modified",
      expectedRevision: installed.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      confirmRemoval: true,
    });

    expect(result.status).toBe("uninstalled");
    await expect(readFile(entry, "utf8")).resolves.toBe("modified\n");
  });

  it("keeps committed files and returns recovery pending when the projection write fails", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await mkdir(join(pluginRoot, ".versions"), { recursive: true });
    await writeFile(join(pluginRoot, ".meta-agent-versions"), "blocks the version owner write", "utf8");

    await expect(
      harness.installer.install({
        requestId: "install-projection-failure",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "installed", recoveryPending: true }));

    await expect(harness.registry.getSnapshot()).resolves.toEqual(
      expect.objectContaining({ plugins: [expect.objectContaining({ id: "dev.meta-agent.example-tools" })] }),
    );
    await expect(
      readFile(
        join(
          harness.agentDir,
          "extensions",
          "dev.meta-agent.example-tools",
          ".versions",
          harness.artifactHash,
          "payload",
          "index.ts",
        ),
        "utf8",
      ),
    ).resolves.toContain("pi.registerTool");
  });

  it("recovers a pre-journal extraction orphan from the main-owned same-filesystem staging area", async () => {
    const harness = await createHarness();
    const orphan = join(
      harness.agentDir,
      "extensions",
      ".meta-agent-marketplace-staging",
      "dev.meta-agent.example-tools-staging",
    );
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "partial-download"), "orphaned", "utf8");
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-after-staging-crash",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    await expect(readFile(join(orphan, "partial-download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts an empty plugin root left by an interrupted GC teardown", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.agentDir, "extensions", "dev.meta-agent.example-tools"), { recursive: true });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-into-orphaned-root",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    await expect(
      readFile(join(harness.agentDir, "extensions", "dev.meta-agent.example-tools", "index.ts"), "utf8"),
    ).resolves.toContain(harness.artifactHash);
  });

  it("installs into an existing inactive plugin directory without ownership metadata", async () => {
    const harness = await createHarness();
    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "user-note.txt"), "preserve me", "utf8");
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-into-unknown-root",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    await expect(readFile(join(pluginRoot, "user-note.txt"), "utf8")).resolves.toBe("preserve me");
  });

  it("preserves user files when an install fails after its version payload landed", async () => {
    const harness = await createHarness({
      beforeRegistryCommit: async (pluginRoot) => {
        await writeFile(join(pluginRoot, "user-note.txt"), "preserve me", "utf8");
        throw new Error("simulated crash before registry commit");
      },
    });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-preserve-unknown",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("simulated crash before registry commit");

    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await expect(readFile(join(pluginRoot, "user-note.txt"), "utf8")).resolves.toBe("preserve me");
    await expect(
      lstat(join(pluginRoot, ".versions", harness.artifactHash)).catch((error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT" ? undefined : Promise.reject(error),
      ),
    ).resolves.toBeUndefined();
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
  });

  it("rejects an update when the active endpoint does not own the installed plugin", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const installed = await harness.installer.install({
      requestId: "install-before-endpoint-switch",
      expectedRevision: initial.revision,
      pluginId: "dev.meta-agent.example-tools",
      version: "1.0.0",
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") throw new Error("Expected installation to succeed");
    harness.endpoints.getActiveEndpoint.mockResolvedValue({
      marketplaceId: "other.market",
      baseUrl: "https://other.test/",
      apiRoot: "https://other.test/v1/",
    });

    await expect(
      harness.installer.update({
        requestId: "update-endpoint-mismatch",
        expectedRevision: installed.snapshot.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "2.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("Marketplace API URL escapes the trusted API root");

    await expect(
      readFile(join(harness.agentDir, "extensions", "dev.meta-agent.example-tools", "index.ts"), "utf8"),
    ).resolves.toContain(harness.artifactHash);
  });

  it("rejects a same-size artifact whose bytes do not match the declared checksum", async () => {
    const harness = await createHarness({
      artifactResponse: (archive) => {
        const tampered = Buffer.from(archive);
        const centralDirectoryOffset = tampered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        if (centralDirectoryOffset < 0) throw new Error("Expected ZIP central directory");
        tampered[centralDirectoryOffset + 5] = tampered[centralDirectoryOffset + 5]! ^ 1;
        return new Response(tampered, { status: 200 });
      },
    });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-checksum-mismatch",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("checksum does not match metadata");

    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
    await expect(
      lstat(
        join(harness.agentDir, "extensions", ".meta-agent-marketplace-staging", "dev.meta-agent.example-tools-staging"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(harness.agentDir, "extensions", "dev.meta-agent.example-tools"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aborts an open artifact response when the download exceeds its declared size", async () => {
    let requestAborted = false;
    let streamCanceled = false;
    let cancellation: Promise<void> | undefined;
    const harness = await createHarness({
      artifactResponse: (archive, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(archive);
            controller.enqueue(Uint8Array.of(0));
          },
          cancel() {
            streamCanceled = true;
          },
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            cancellation = body.cancel(init?.signal?.reason);
          },
          { once: true },
        );
        return new Response(body, { status: 200 });
      },
    });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-oversized-download",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("exceeds its declared size");

    expect(requestAborted).toBe(true);
    if (!cancellation) throw new Error("Expected artifact response cancellation");
    await cancellation;
    expect(streamCanceled).toBe(true);
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
  });

  it("rejects an artifact key that cannot be used as an immutable version directory", async () => {
    const harness = await createHarness({ artifactKey: "../escape" });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-invalid-artifact-key",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("Marketplace artifact metadata is invalid");

    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
  });

  it("allows independent plugin mutations to resolve endpoints concurrently", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();
    const endpoint = await harness.endpoints.getActiveEndpoint();
    let releaseEndpoint: ((value: typeof endpoint) => void) | undefined;
    const endpointGate = new Promise<typeof endpoint>((resolve) => {
      releaseEndpoint = resolve;
    });
    harness.endpoints.getActiveEndpoint.mockClear();
    harness.endpoints.getActiveEndpoint
      .mockImplementationOnce(() => endpointGate)
      .mockImplementation(async () => endpoint);

    const first = harness.installer
      .install({
        requestId: "concurrent-first",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(harness.endpoints.getActiveEndpoint).toHaveBeenCalledTimes(1));

    const second = harness.installer
      .install({
        requestId: "concurrent-second",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.other-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(harness.endpoints.getActiveEndpoint).toHaveBeenCalledTimes(2));

    if (!releaseEndpoint) throw new Error("endpoint gate was not initialized");
    releaseEndpoint(endpoint);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ status: "fulfilled", value: { status: "installed" } });
    expect(secondResult).toMatchObject({ status: "rejected", error: expect.any(Error) });
  });

  it("installs without signature metadata", async () => {
    const harness = await createHarness();
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-without-signature",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).resolves.toMatchObject({ status: "installed" });
  });
});

async function createHarness(
  options: {
    omitConfigurationCapability?: boolean;
    beforeRegistryCommit?(pluginRoot: string): Promise<void>;
    artifactResponse?(archive: Uint8Array, init?: RequestInit): Response;
    artifactKey?: string;
    runtimeCompatibility?: RuntimeCompatibility;
  } = {},
) {
  const root = join(tmpdir(), `plugin-marketplace-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const harnessRuntime = options.runtimeCompatibility ?? runtime;
  const target = { platform: "universal", arch: "universal", piVersion: harnessRuntime.piVersion };
  const buildArtifact = (version: string) => {
    const artifactId = `example-tools-${version}-universal`;
    const payload = Buffer.from(
      `export default function example(pi: { registerTool(value: unknown): void }) { pi.registerTool({ name: 'example-${version}' }); }\n`,
      "utf8",
    );
    const manifest = {
      schemaVersion: 1,
      marketplaceId: "local.market",
      artifactId,
      plugin: {
        id: "dev.meta-agent.example-tools",
        name: "Example Tools",
        version,
        publisherId: "dev.meta-agent",
      },
      pi: { entry: "payload/index.ts", extensionApi: "1" },
      desktop: { hostProfileVersion: 1, minVersion: "0.0.31" },
      target,
      configuration: {
        version: 1,
        fields: [
          {
            key: "endpoint",
            label: "Endpoint",
            type: "text",
            required: true,
            defaultValue: "https://example.test",
          },
        ],
      },
      capabilities: options.omitConfigurationCapability ? ["tools.register"] : ["tools.register", "configuration.read"],
      nativeModules: [],
      executables: [],
      files: {
        "payload/index.ts": {
          mode: "0644",
        },
      },
    };
    const archive = Buffer.from(
      zipSync(
        {
          "market-manifest.json": Buffer.from(JSON.stringify(manifest), "utf8"),
          "payload/index.ts": payload,
        },
        { level: 9 },
      ),
    );
    const sha256 = options.artifactKey ?? createHash("sha256").update(archive).digest("hex");
    const downloadEndpoint = `https://market.test/v1/plugins/dev.meta-agent.example-tools/versions/${version}/artifacts/${artifactId}/download`;
    const artifactUrl = `https://artifacts.test/${artifactId}.meta-plugin`;
    return { version, artifactId, archive, sha256, downloadEndpoint, artifactUrl };
  };
  const artifacts = new Map(["1.0.0", "2.0.0"].map((version) => [version, buildArtifact(version)]));
  const artifactHash = artifacts.get("1.0.0")!.sha256;
  const updateArtifactHash = artifacts.get("2.0.0")!.sha256;
  const apiRoot = "https://market.test/v1/";
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const version = url.pathname.match(/\/versions\/([^/]+)\//)?.[1];
    const artifact = version
      ? artifacts.get(version)
      : [...artifacts.values()].find((item) => item.artifactUrl === url.href);
    if (!artifact) return new Response("not found", { status: 404 });
    if (url.pathname.endsWith("/artifacts")) {
      return Response.json({
        artifacts: [
          {
            id: artifact.artifactId,
            target,
            sha256: artifact.sha256,
            size: artifact.archive.byteLength,
            containsNativeCode: false,
            preferred: true,
            downloadEndpoint: artifact.downloadEndpoint,
          },
        ],
      });
    }
    if (url.pathname.endsWith("/download")) {
      return Response.json({
        pluginId: "dev.meta-agent.example-tools",
        version: artifact.version,
        artifactId: artifact.artifactId,
        url: artifact.artifactUrl,
        sha256: artifact.sha256,
        size: artifact.archive.byteLength,
      });
    }
    if (url.href === artifact.artifactUrl) {
      return options.artifactResponse?.(artifact.archive, init) ?? new Response(artifact.archive, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const trustedEndpoint = {
    marketplaceId: "local.market",
    baseUrl: "https://market.test/",
    apiRoot,
  };
  const endpoints = {
    getActiveEndpoint: vi.fn(async () => trustedEndpoint),
  };
  const registry = new MarketplacePluginRegistry(userDataDir, { createId: () => "registry-revision" });
  const installer = new MarketplacePluginInstaller(
    endpoints as never,
    registry,
    join(userDataDir, "plugins", "locks"),
    agentDir,
    "0.0.31",
    harnessRuntime,
    {
      fetch: fetchImpl as typeof fetch,
      createId: () => "staging",
      now: () => 1_800_000_000_000,
      ...(options.beforeRegistryCommit
        ? {
            beforeRegistryCommit: () =>
              options.beforeRegistryCommit(join(agentDir, "extensions", "dev.meta-agent.example-tools")),
          }
        : {}),
    },
  );
  return {
    userDataDir,
    agentDir,
    endpoints,
    registry,
    installer,
    artifactHash,
    updateArtifactHash,
    fetchImpl,
    endpoint: trustedEndpoint,
  };
}
