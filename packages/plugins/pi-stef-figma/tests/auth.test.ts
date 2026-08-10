import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadAuthorization() {
  vi.resetModules();
  return import("../src/auth/FigmaAuthorization");
}

describe("FigmaAuthorization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads apiToken from ~/.pi/sf/figma/config.json as the canonical config", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-home-"));
    vi.stubEnv("HOME", home);
    fs.mkdirSync(path.join(home, ".pi", "sf", "figma"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "sf", "figma", "config.json"),
      JSON.stringify({ apiToken: "token-from-pi-config" }),
    );

    const { FigmaAuthorization, FIGMA_CONFIG_PATH } = await loadAuthorization();
    const auth = new FigmaAuthorization();

    expect(FIGMA_CONFIG_PATH).toBe(path.join(home, ".pi", "sf", "figma", "config.json"));
    expect(auth.getConfig()).toEqual({ apiToken: "token-from-pi-config" });
  });

  it("sends the configured token without exposing it in tool output", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-home-"));
    vi.stubEnv("HOME", home);
    process.env.FIGMA_API_TOKEN = "env-token";
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const { FigmaAuthorization } = await loadAuthorization();
    const auth = new FigmaAuthorization();

    await auth.fetch("https://api.figma.com/v1/files/example");

    const calls = fetchMock.mock.calls as Array<[string | URL, RequestInit?]>;
    const headers = calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Figma-Token")).toBe("env-token");
  });

  it("prefers the host-provided Desktop token over file and env sources", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-home-"));
    vi.stubEnv("HOME", home);
    fs.mkdirSync(path.join(home, ".pi", "sf", "figma"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "sf", "figma", "config.json"),
      JSON.stringify({ apiToken: "token-from-file" }),
    );
    process.env.FIGMA_API_TOKEN = "token-from-env";
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const { FigmaAuthorization } = await loadAuthorization();
    const auth = new FigmaAuthorization({ apiToken: "token-from-desktop-config" });

    expect(auth.getConfig()).toEqual({ apiToken: "token-from-desktop-config" });
    await auth.fetch("https://api.figma.com/v1/files/example");

    const calls = fetchMock.mock.calls as Array<[string | URL, RequestInit?]>;
    const headers = calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Figma-Token")).toBe("token-from-desktop-config");
  });
});
