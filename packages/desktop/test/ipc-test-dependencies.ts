import type { ApplicationIpcDependencies } from "../src/main/ipc.ts";

/** 为 IPC 单元测试提供最小命名依赖，测试只覆盖显式覆盖的领域。 */
export function createIpcTestDependencies(overrides: Partial<ApplicationIpcDependencies>): ApplicationIpcDependencies {
  return {
    projects: {} as ApplicationIpcDependencies["projects"],
    sessions: {} as ApplicationIpcDependencies["sessions"],
    scm: {} as ApplicationIpcDependencies["scm"],
    scmWatcher: {} as ApplicationIpcDependencies["scmWatcher"],
    files: {} as ApplicationIpcDependencies["files"],
    officeDocuments: {} as ApplicationIpcDependencies["officeDocuments"],
    fileWatcher: {} as ApplicationIpcDependencies["fileWatcher"],
    terminals: { disposeProject: () => undefined } as unknown as ApplicationIpcDependencies["terminals"],
    models: {} as ApplicationIpcDependencies["models"],
    auth: {} as ApplicationIpcDependencies["auth"],
    providers: {} as ApplicationIpcDependencies["providers"],
    settings: {} as ApplicationIpcDependencies["settings"],
    dirtyGuard: {} as ApplicationIpcDependencies["dirtyGuard"],
    ...overrides,
  };
}
