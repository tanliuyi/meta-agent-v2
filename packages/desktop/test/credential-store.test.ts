import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/main/models/credential-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileCredentialStore", () => {
  it("makes an external auth.json write visible to an existing ModelRuntime after refresh", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
    tempDirs.push(agentDir);
    const authPath = join(agentDir, "auth.json");
    const credentials = new FileCredentialStore(authPath);
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    });

    expect(await runtime.getAvailable("anthropic")).toEqual([]);
    await writeFile(authPath, `${JSON.stringify({ anthropic: { type: "api_key", key: "external-key" } }, null, 2)}\n`);

    await runtime.refresh({ allowNetwork: false });

    expect((await runtime.getAvailable("anthropic")).length).toBeGreaterThan(0);
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
  });

  it("resolves environment templates, interpolation, and escapes like Pi auth storage", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
    tempDirs.push(agentDir);
    const credentials = new FileCredentialStore(join(agentDir, "auth.json"));
    process.env.DESKTOP_CREDENTIAL_PROCESS = "process";
    try {
      await credentials.modify("templated", async () => ({
        type: "api_key",
        key: "prefix-$DESKTOP_CREDENTIAL_SCOPED-$" + "{DESKTOP_CREDENTIAL_PROCESS}-$$-$!",
        env: { DESKTOP_CREDENTIAL_SCOPED: "scoped" },
      }));
      await credentials.modify("missing", async () => ({ type: "api_key", key: "$DESKTOP_CREDENTIAL_MISSING" }));

      await expect(credentials.read("templated")).resolves.toEqual({
        type: "api_key",
        key: "prefix-scoped-process-$-!",
        env: { DESKTOP_CREDENTIAL_SCOPED: "scoped" },
      });
      await expect(credentials.read("missing")).resolves.toEqual({ type: "api_key", key: undefined });
    } finally {
      delete process.env.DESKTOP_CREDENTIAL_PROCESS;
    }
  });

  it("resolves leading shell commands and trims stdout", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
    tempDirs.push(agentDir);
    const credentials = new FileCredentialStore(join(agentDir, "auth.json"));
    const executable = JSON.stringify(process.execPath.replaceAll("\\", "/"));
    await credentials.modify("command", async () => ({
      type: "api_key",
      key: `!${executable} -e "process.stdout.write(' command-key ')"`,
    }));

    await expect(credentials.read("command")).resolves.toEqual({ type: "api_key", key: "command-key" });
  });

  it("treats an undefined modify result as no change and reserves deletion for delete", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "desktop-credentials-"));
    tempDirs.push(agentDir);
    const credentials = new FileCredentialStore(join(agentDir, "auth.json"));
    await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));

    await expect(credentials.modify("anthropic", async () => undefined)).resolves.toEqual({
      type: "api_key",
      key: "stored-key",
    });
    await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "stored-key" });

    await credentials.delete("anthropic");
    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
  });
});
