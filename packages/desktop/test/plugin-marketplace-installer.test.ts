import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplacePluginInstaller } from "../src/main/plugins/marketplace-plugin-installer.ts";
import { MarketplacePluginRegistry } from "../src/main/plugins/marketplace-plugin-registry.ts";
import { MarketplacePluginTransactionStore } from "../src/main/plugins/marketplace-plugin-transaction-store.ts";
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
  it("verifies and installs a signed artifact using an immutable Pi extension projection", async () => {
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
        capabilities: ["tools.register"],
        containsNativeCode: false,
        enabled: true,
      }),
    ]);
    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(
      expect.objectContaining({ plugins: [expect.objectContaining({ artifactHash: harness.artifactHash })] }),
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
      new MarketplacePluginTransactionStore(harness.userDataDir),
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

  it("retains a projection-committed transaction while immediate apply is pending", async () => {
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
    await expect(harness.installer.getPendingApplyTransaction("install-for-apply")).resolves.toEqual(
      expect.objectContaining({
        phase: "projection-committed",
        applyTarget: { projectId: "project", threadId: "thread" },
      }),
    );
    if (result.status !== "installed") throw new Error("Expected installation");
    await expect(
      harness.installer.update({
        requestId: "update-while-apply-pending",
        expectedRevision: result.snapshot.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "2.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("recovery is pending");
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
    harness.endpoints.getActiveTrustedEndpoint.mockRejectedValue(new Error("another marketplace is active"));

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
    expect(harness.endpoints.getTrustedEndpoint).toHaveBeenCalledWith("local.market");
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
    await expect(harness.transactions.list()).resolves.toEqual([]);
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
    await expect(harness.transactions.list()).resolves.toEqual([]);

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

  it("refuses to uninstall a modified managed version", async () => {
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

    await expect(
      harness.installer.uninstall({
        requestId: "uninstall-modified",
        expectedRevision: installed.snapshot.revision,
        pluginId: "dev.meta-agent.example-tools",
        confirmRemoval: true,
      }),
    ).rejects.toThrow("integrity failed");
    await expect(harness.registry.getSnapshot()).resolves.toEqual(installed.snapshot);

    const preserved = await harness.installer.uninstall({
      requestId: "uninstall-preserve-modified",
      expectedRevision: installed.snapshot.revision,
      pluginId: "dev.meta-agent.example-tools",
      confirmRemoval: true,
      confirmPreserveModifiedFiles: true,
    });
    expect(preserved.status).toBe("uninstalled");
    await expect(readFile(entry, "utf8")).resolves.toBe("modified\n");
  });

  it("never removes committed files when the registry phase journal write fails", async () => {
    const harness = await createHarness({ failJournalPhase: "registry-committed" });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-journal-failure",
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
    await expect(harness.transactions.list()).resolves.toEqual([
      expect.objectContaining({ phase: "files-ready", operation: "install" }),
    ]);
  });

  it("rejects a version denied by the signed revocation policy before download", async () => {
    const harness = await createHarness({ revocationError: "withdrawn" });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-revoked",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("withdrawn");
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
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

  it("refuses to install into a tombstone-less root that has content", async () => {
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
    ).rejects.toThrow("no valid ownership tombstone");

    await expect(readFile(join(pluginRoot, "user-note.txt"), "utf8")).resolves.toBe("preserve me");
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
  });

  it("does not delete unknown files when rolling back a newly created plugin root", async () => {
    const harness = await createHarness({
      failJournalPhase: "files-ready",
      writeUnknownRootOnJournalFailure: true,
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
    ).rejects.toThrow("simulated journal failure");

    const pluginRoot = join(harness.agentDir, "extensions", "dev.meta-agent.example-tools");
    await expect(readFile(join(pluginRoot, "user-note.txt"), "utf8")).resolves.toBe("preserve me");
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
    await expect(harness.transactions.list()).resolves.toEqual([]);
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

  it("rejects a bad manifest signature and removes the staging root", async () => {
    const harness = await createHarness({ corruptSignature: true });
    const initial = await harness.registry.getSnapshot();

    await expect(
      harness.installer.install({
        requestId: "install-bad-signature",
        expectedRevision: initial.revision,
        pluginId: "dev.meta-agent.example-tools",
        version: "1.0.0",
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("signature is invalid");

    await expect(
      readFile(join(harness.agentDir, "extensions", "dev.meta-agent.example-tools", "index.ts")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(harness.registry.getSnapshot()).resolves.toEqual(initial);
  });
});

async function createHarness(
  options: {
    corruptSignature?: boolean;
    failJournalPhase?: string;
    revocationError?: string;
    writeUnknownRootOnJournalFailure?: boolean;
    artifactResponse?(archive: Uint8Array, init?: RequestInit): Response;
  } = {},
) {
  const root = join(tmpdir(), `plugin-marketplace-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const target = { platform: "universal", arch: "universal", piVersion: runtime.piVersion };
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
      capabilities: ["tools.register"],
      nativeModules: [],
      executables: [],
      files: {
        "payload/index.ts": {
          sha256: createHash("sha256").update(payload).digest("hex"),
          size: payload.byteLength,
          mode: "0644",
        },
      },
    };
    const signatureBytes = options.corruptSignature
      ? Buffer.alloc(64)
      : sign(null, Buffer.from(canonicalJson(manifest), "utf8"), keyPair.privateKey);
    const archive = Buffer.from(
      zipSync(
        {
          "market-manifest.json": Buffer.from(canonicalJson(manifest), "utf8"),
          "signature.json": Buffer.from(
            canonicalJson({ algorithm: "ed25519", keyId: "key-1", value: signatureBytes.toString("base64") }),
            "utf8",
          ),
          "payload/index.ts": payload,
        },
        { level: 9 },
      ),
    );
    const sha256 = createHash("sha256").update(archive).digest("hex");
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
    artifactOrigins: ["https://artifacts.test"],
    signing: {
      algorithm: "ed25519" as const,
      keyId: "key-1",
      publicKey,
      fingerprint: `sha256:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")}`,
    },
    active: true,
  };
  const endpoints = {
    getActiveTrustedEndpoint: vi.fn(async () => trustedEndpoint),
    getTrustedEndpoint: vi.fn(async (marketplaceId: string) => {
      if (marketplaceId !== trustedEndpoint.marketplaceId) throw new Error("Marketplace trust record is unavailable");
      return trustedEndpoint;
    }),
  };
  const registry = new MarketplacePluginRegistry(userDataDir, { createId: () => "registry-revision" });
  const transactions = new MarketplacePluginTransactionStore(userDataDir, {
    createId: () => "operation-1",
    now: () => 1_800_000_000_000,
  });
  const transactionApi = options.failJournalPhase
    ? {
        prepare: transactions.prepare.bind(transactions),
        setPhase: async (...args: Parameters<MarketplacePluginTransactionStore["setPhase"]>) => {
          if (args[1] === options.failJournalPhase) {
            if (options.writeUnknownRootOnJournalFailure) {
              await writeFile(
                join(agentDir, "extensions", "dev.meta-agent.example-tools", "user-note.txt"),
                "preserve me",
                "utf8",
              );
            }
            throw new Error("simulated journal failure");
          }
          return transactions.setPhase(...args);
        },
        complete: transactions.complete.bind(transactions),
        list: transactions.list.bind(transactions),
        withPluginLock: transactions.withPluginLock.bind(transactions),
      }
    : transactions;
  const installer = new MarketplacePluginInstaller(
    endpoints as never,
    registry,
    transactionApi as MarketplacePluginTransactionStore,
    agentDir,
    "0.0.31",
    runtime,
    {
      fetch: fetchImpl as typeof fetch,
      createId: () => "staging",
      now: () => 1_800_000_000_000,
      ...(options.revocationError
        ? {
            revocations: {
              assertArtifactAllowed: async () => {
                throw new Error(options.revocationError);
              },
            },
          }
        : {}),
    },
  );
  return {
    userDataDir,
    agentDir,
    endpoints,
    registry,
    transactions,
    installer,
    artifactHash,
    updateArtifactHash,
    fetchImpl,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}
