import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreServices } from "../src/main/bootstrap/core-services.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  readCredential: vi.fn(),
  projects: { load: vi.fn(), list: vi.fn(), getCwd: vi.fn() },
  modelRuntime: {},
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ ModelRuntime: { create: vi.fn() } }));
vi.mock("../src/main/store/project-store.ts", () => ({
  ProjectStore: vi.fn(function ProjectStore() {
    return mocks.projects;
  }),
}));
vi.mock("../src/main/files/file-service.ts", () => ({
  FileService: vi.fn(function FileService() {
    return {};
  }),
}));
vi.mock("../src/main/models/credential-store.ts", () => ({
  FileCredentialStore: vi.fn(function FileCredentialStore() {
    return { read: mocks.readCredential };
  }),
}));
vi.mock("../src/main/models/models-config-service.ts", () => ({
  ModelsConfigService: vi.fn(function ModelsConfigService() {
    return {};
  }),
}));
vi.mock("../src/main/auth/auth-config-service.ts", () => ({
  AuthConfigService: vi.fn(function AuthConfigService() {
    return {};
  }),
}));
vi.mock("../src/main/providers/providers-config-service.ts", () => ({
  ProvidersConfigService: vi.fn(function ProvidersConfigService() {
    return {};
  }),
}));
vi.mock("../src/main/preferences/preferences-config-service.ts", () => ({
  PreferencesConfigService: vi.fn(function PreferencesConfigService() {
    return {};
  }),
}));
vi.mock("../src/main/settings/settings-config-service.ts", () => ({
  SettingsConfigService: vi.fn(function SettingsConfigService() {
    return {};
  }),
}));
vi.mock("../src/main/settings/memory-settings-service.ts", () => ({
  MemorySettingsService: vi.fn(function MemorySettingsService() {
    return {};
  }),
}));
vi.mock("../src/main/settings/auto-title-settings-service.ts", () => ({
  AutoTitleSettingsService: vi.fn(function AutoTitleSettingsService() {
    return {};
  }),
}));
vi.mock("../src/main/pi/desktop-builtin-provider.ts", () => ({
  DesktopBuiltinProviderRegistry: {
    getKnownProviderInfos: vi.fn(() => [{ id: "known", envKeys: ["CORE_SERVICES_TEST_KEY"] }]),
  },
}));

function context() {
  return { agentDir: "C:/agent", userDataDir: "C:/data", sidecarLog: { write: vi.fn() } } as never;
}

describe("createCoreServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORE_SERVICES_TEST_KEY;
    mocks.projects.load.mockResolvedValue(undefined);
    mocks.readCredential.mockResolvedValue(undefined);
    vi.mocked(ModelRuntime.create).mockResolvedValue(mocks.modelRuntime as never);
  });

  it("starts project loading and model runtime creation before awaiting either", async () => {
    let resolveProjects!: () => void;
    let resolveRuntime!: (value: never) => void;
    mocks.projects.load.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveProjects = resolve;
      }),
    );
    vi.mocked(ModelRuntime.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
    );

    const pending = createCoreServices(context());
    await Promise.resolve();
    expect(mocks.projects.load).toHaveBeenCalledOnce();
    expect(ModelRuntime.create).toHaveBeenCalledOnce();
    resolveProjects();
    resolveRuntime(mocks.modelRuntime as never);

    await expect(pending).resolves.toMatchObject({ projects: mocks.projects, modelRuntime: mocks.modelRuntime });
  });

  it("propagates an asynchronous prerequisite failure", async () => {
    mocks.projects.load.mockRejectedValueOnce(new Error("project load failed"));
    await expect(createCoreServices(context())).rejects.toThrow("project load failed");
  });

  it("reports missing and configured provider capability", async () => {
    const services = await createCoreServices(context());
    await expect(services.isDesktopProviderAvailable("known")).resolves.toBe(false);
    mocks.readCredential.mockResolvedValueOnce({ type: "oauth" });
    await expect(services.isDesktopProviderAvailable("known")).resolves.toBe(true);
  });
});
