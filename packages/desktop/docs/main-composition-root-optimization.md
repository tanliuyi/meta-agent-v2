# Desktop Main Composition Root 优化方案

## 1. 文档目的

本文分析 `packages/desktop/src/main/index.ts` 的主进程编排职责，并制定在不改变现有 IPC contract、sidecar protocol、session 持久化格式和用户功能的前提下，降低启动入口复杂度的重构方案。

本文讨论的是 composition root（组合根）：应用唯一负责实例化对象、连接依赖、启动生命周期和释放资源的边界。业务逻辑仍归领域服务所有，不迁移到组合根。

## 2. 结论摘要

当前 `index.ts` 不是单纯的 Electron 入口，而是以下四种职责的混合体：

1. Electron 生命周期和窗口策略。
2. 所有主进程服务的实例化和启动顺序控制。
3. Session、subagent、browser 之间的跨域回调连接。
4. 应用退出时的资源释放编排。

它目前约 705 行；`ipc.ts` 约 1140 行；`SessionSupervisor` 约 662 行；`ThreadWorkerRegistry` 约 2056 行。入口本身的行数不是唯一问题，关键问题是依赖关系以匿名对象字面量和闭包形式集中在一个函数内，导致依赖方向难以观察、测试替身难以注入、初始化顺序依赖隐式变量。

建议采用三个宏观阶段、六个实施 Phase：

- 第一阶段：建立保护网，并拆分 runtime context、core services 和 plugin services。
- 第二阶段：拆分 session services，使用显式 port 替代跨域闭包。
- 第三阶段：拆分 workspace/browser/IPC，并统一应用退出生命周期。

目标不是减少所有文件数量，而是让 `index.ts` 只保留 Electron 启动、应用 bootstrap 和退出三件事。

## 3. 现状结构

### 3.1 启动入口的实际职责

`packages/desktop/src/main/index.ts` 当前包含：

- 应用单实例锁、第二实例聚焦和远程调试端口。
- 自定义 scheme 注册：本地图片、PDF、浏览器内部页。
- BrowserWindow 创建、安全策略、快捷键、dirty guard。
- React DevTools 安装。
- managed shell 定位和 shell runtime setup。
- `ProjectStore`、`FileService`、配置服务和 credential store 实例化。
- marketplace registry、reconciler、installer、GC 和 extension policy 实例化。
- metadata worker、thread worker、subagent worker 实例化。
- SessionSupervisor 与 worker registry 的双向回调连接。
- BrowserManager、browser host server 与 sidecar browser capability 的连接。
- TerminalSupervisor 与 worker registry 的 workspace mutation 连接。
- `registerIpc(...)` 的全部领域依赖组装。
- updater 和 marketplace GC 定时任务。
- quit 时 browser、terminal、thread worker、subagent worker、metadata worker、log 的关闭顺序。

主要证据位置：

- `packages/desktop/src/main/index.ts:140`：窗口构造。
- `packages/desktop/src/main/index.ts:229`：`app.whenReady()` 启动流程。
- `packages/desktop/src/main/index.ts:356`：metadata worker 创建。
- `packages/desktop/src/main/index.ts:386`：thread worker registry 创建。
- `packages/desktop/src/main/index.ts:445`：SessionSupervisor 创建。
- `packages/desktop/src/main/index.ts:450`：TerminalSupervisor 创建。
- `packages/desktop/src/main/index.ts:477`：BrowserManager 创建。
- `packages/desktop/src/main/index.ts:514`：IPC 注册。
- `packages/desktop/src/main/index.ts:649`：退出编排。

### 3.2 当前启动顺序

```text
模块级 Electron 配置
  -> app.whenReady
  -> 计算 userDataDir / agentDir / shellPath
  -> ProjectStore + FileService
  -> projects.load() 并行启动
  -> models / credentials / settings / preferences
  -> extension settings
  -> marketplace settings / registry / plugin configuration
  -> marketplace reconcile
  -> ModelRuntime.create + projects.load + reconcile + DevTools 完成
  -> AuthConfigService
  -> ExtensionSourcePolicy
  -> updater + sidecar runtime manifest
  -> MarketplaceCatalog + Installer
  -> MetadataWorkerClient
  -> SubagentWorkerRegistry（依赖延迟 supervisor）
  -> ThreadWorkerRegistry（依赖延迟 supervisor、subagents、terminals、browser）
  -> SessionSupervisor
  -> TerminalSupervisor
  -> Providers / AutoTitle
  -> BrowserDataService + BrowserManager + BrowserHostServer
  -> SubagentSettingsConfigService
  -> registerIpc
  -> createWindow
  -> updater / marketplace GC 定时任务
```

这个顺序中有三种不同性质的依赖被混在一起：

- 必须先完成的异步准备：项目加载、模型 runtime、marketplace reconcile。
- 可以立即构造但依赖其他服务的配置服务：settings、preferences、memory settings、auth、providers、auto-title。
- 只能在运行时使用的反向回调：worker push、host request、browser capability、terminal mutation。

应分别表达 construction graph 和 readiness graph：

```text
Construction graph：对象创建所需的同步依赖
ProjectStore -> FileService
ModelRuntime -> Auth -> Providers / AutoTitle
ProjectStore -> MemorySettings
Plugin registry -> Plugin configuration / SourcePolicy
Runtime manifest + plugin services -> worker registries
Worker registry -> SessionSupervisor
```

```text
Readiness graph：启动前必须完成的异步准备
projects.load()
ModelRuntime.create()
marketplaceReconciler.reconcile()
createBrowserHostServer()
metadataWorker.ready()
registerIpc()
createWindow()
```

这些任务不必全部串行；只有实际存在数据依赖的节点才等待前置节点。factory 的 API 应明确区分同步构造和异步 ready，避免为了隐藏编排而把可并行任务错误串行化。

后两类应该分开表达。当前代码使用 `let supervisor`、`let subagentRegistry`、`let browserManagerInstance` 和 `terminals?` 闭包捕获来解决它们，导致初始化时序成为隐式协议。

## 4. 依赖问题详解

### 4.1 `index.ts` 是服务定位器和手工 DI 容器的混合体

主入口既直接 `new` 服务，又把大量匿名闭包作为依赖传入。例如 `ThreadWorkerRegistry` 的 options 同时包含：

- metadata
- extension source policy
- project path resolver
- workspace lock
- supervisor event push
- subagent host bridge
- terminal workspace restore
- checkpoint cleanup
- browser capability
- mutation lifecycle

这些依赖本身并不都属于 ThreadWorkerRegistry 的同一抽象层。它们分别属于：

```text
Session routing
Subagent coordination
Workspace mutation coordination
Browser capability
Persistence cleanup
Renderer event publication
```

结果是 registry 的构造参数成为跨域协议的聚合点，主入口必须理解每个 callback 的语义。

### 4.2 循环依赖是运行时变量，不是类型依赖

当前代码先声明：

```ts
let supervisor: SessionSupervisor | undefined;
let subagentRegistry: SubagentWorkerRegistry | undefined;
```

随后在两个 registry 的回调中检查这些变量，最后才创建并赋值 `SessionSupervisor`。类似逻辑还出现在 browser 和 terminal 连接上。

这种做法解决了构造顺序，但有三个具体成本：

1. 回调在赋值前触发时必须有特殊降级逻辑，例如直接 ack，否则可能造成事件积压。
2. 类型上所有依赖都变成可选，真实运行时却认为它们最终一定存在。
3. 单元测试必须模拟一套“未初始化、初始化中、初始化完成”的隐含状态。

这是初始化阶段的 temporal coupling（时间耦合）：对象是否可用取决于构造函数执行到哪一行，而不是依赖对象本身的类型。

### 4.3 生命周期所有权分散

当前退出代码的调用顺序如下，但它不是严格的完成顺序：

```text
调用 browserManager.dispose()
  -> 启动但不等待 browserHostServer.dispose()
  -> 调用 TerminalSupervisor.dispose()
  -> await SessionSupervisor.dispose()
  -> await SubagentWorkerRegistry.dispose()
  -> await MetadataWorkerClient.dispose()
  -> await SidecarLog.dispose()
```

其中 `browserHostServer.dispose()` 当前通过 `void` 启动，`TerminalSupervisor.dispose()` 当前也不作为 await 节点；因此文档不能把它描述为所有资源依次完成释放。重构时应先确认每个服务的关闭语义，再定义 application shutdown phases。

- 在哪里保存变量。
- 是否要在 before-quit 中停止。
- 是否需要先阻止新请求。
- 是否需要等待 pending operation。
- 失败时是否继续释放其他资源。

这会使退出流程成为高风险区域。

### 4.4 IPC 注册进一步放大入口依赖

`registerIpc` 位于 `packages/desktop/src/main/ipc.ts:138`，接收大量位置参数和可选领域服务。当前调用者必须按固定位置传入：

- project/session
- SCM
- files
- office preview
- file watcher
- terminals
- model/auth/provider/settings
- dirty guard
- runtime dependencies
- updater
- extensions
- subagents
- marketplace
- plugin configuration
- memory
- auto title
- preferences
- browser

位置参数使重构和 review 都容易出错。即使不立即拆 IPC 文件，也应该先改成命名依赖对象：

```ts
registerIpc({
  projects,
  sessions,
  files,
  scm,
  terminals,
  settings: { models, auth, providers, settings, preferences },
  plugins: { extensions, marketplace, configurations },
  browser,
  updater,
  dirtyGuard,
});
```

这一步只改善可读性和注入，不改变 channel 行为。

## 5. 目标架构

### 5.1 目标模块

```text
src/main/index.ts
  └── DesktopApplication
        ├── createDesktopRuntimeContext
        ├── createCoreServices
        ├── createPluginServices
        ├── createSessionServices
        ├── createWorkspaceServices
        ├── createBrowserServices
        ├── registerApplicationIpc
        └── dispose
```

建议新增目录：

```text
packages/desktop/src/main/bootstrap/
├── application.ts
├── runtime-context.ts
├── core-services.ts
├── plugin-services.ts
├── session-services.ts
├── workspace-services.ts
├── browser-services.ts
├── ipc-registration.ts
└── resource-scope.ts
```

这些 factory 只负责组合，不实现业务规则。

### 5.2 目标依赖方向

```text
runtime-context
  ├── paths
  ├── platform
  ├── runtime manifest
  ├── logger
  └── shell runtime

core-services
  ├── projects
  ├── models
  ├── credentials
  ├── auth
  ├── providers
  ├── settings
  └── preferences

plugin-services
  ├── extension settings
  ├── plugin configuration
  ├── marketplace registry
  ├── marketplace catalog
  ├── installer
  ├── reconciler
  ├── generation references
  └── extension source policy

session-services
  ├── metadata client
  ├── subagent registry
  ├── thread worker registry
  └── session supervisor

workspace-services
  ├── files
  ├── file watcher
  ├── SCM
  ├── SCM watcher
  ├── terminals
  └── office preview

browser-services
  ├── browser data
  ├── browser manager
  └── browser host server

ipc-registration
  └── consumes completed service graph
```

依赖只能从下往上使用：

```text
领域服务 -> runtime context / domain interfaces
bootstrap factory -> 领域服务
application -> bootstrap factory
index -> application
```

领域服务不得反向 import `bootstrap/*`。

### 5.3 生命周期阶段

将启动明确分为五个阶段：

```ts
interface DesktopApplication {
  initialize(): Promise<void>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}
```

#### Phase 1：构造运行时上下文

同步计算并冻结：

- `appDir`
- `userDataDir`
- `agentDir`
- packaged/development 状态
- sidecar manifest
- shell path
- logger
- platform capabilities

不要在这一阶段创建 worker 或注册 IPC。

#### Phase 2：构造无运行依赖的服务

构造项目、配置、凭据、模型、插件 registry 等服务，并启动必要的异步准备：

- `projects.load()`
- `ModelRuntime.create(...)`
- marketplace reconcile
- React DevTools install

使用 named result 返回，不依赖外部可变变量。

#### Phase 3：构造跨域运行服务

在 Phase 2 的结果完成后创建：

- browser manager / host server
- metadata client
- subagent registry
- thread worker registry
- session supervisor
- terminal supervisor

跨域桥接使用显式 port，而不是捕获尚未赋值的局部变量。

#### Phase 4：注册 IPC 和窗口

只有完整 application service graph 可用后：

- 注册 IPC handlers。
- 注册 scheme handlers 的动态部分。
- 创建 BrowserWindow。
- 启动 updater 和 marketplace GC 定时器。

#### Phase 5：运行

应用进入 steady state。运行期间不再修改 bootstrap 依赖引用；配置变更通过现有 generation/refresh API 传播。

## 6. 推荐的 factory 接口

### 6.1 RuntimeContext

```ts
export interface DesktopRuntimeContext {
  readonly appDir: string;
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly manifest: SidecarRuntimeManifest;
  readonly shellPath?: string;
  readonly log: SidecarLog;
}
```

`runtime-context.ts` 负责路径和启动前置条件，不负责构造领域服务。

### 6.2 CoreServices

```ts
export interface CoreServices {
  readonly projects: ProjectStore;
  readonly files: FileService;
  readonly models: ModelsConfigService;
  readonly credentials: FileCredentialStore;
  readonly modelRuntime: ModelRuntime;
  readonly auth: AuthConfigService;
  readonly providers: ProvidersConfigService;
  readonly settings: SettingsConfigService;
  readonly preferences: PreferencesConfigService;
  readonly memorySettings: MemorySettingsService;
  readonly autoTitleSettings: AutoTitleSettingsService;
  /** core 异步前置工作完成后 resolve；不包含 marketplace 或 worker 启动。 */
  readonly ready: Promise<void>;
}

export async function createCoreServices(
  context: DesktopRuntimeContext,
): Promise<CoreServices>;
```

`CoreServices` 的接口必须与 Phase 1 的迁移边界一致：

- `ProjectStore` 完成构造后才能创建 `FileService` 和 memory settings 的项目查询回调。
- `ModelRuntime` 完成创建后才能创建 `AuthConfigService`、`ProvidersConfigService` 和 `AutoTitleSettingsService`。
- `ModelsConfigService`、`SettingsConfigService`、`PreferencesConfigService` 可以在相关路径准备完成后同步构造。
- `MemorySettingsService` 和 `AutoTitleSettingsService` 虽然属于 core service graph，但不是无依赖配置服务。

`createCoreServices()` 应在内部并行启动互不依赖的准备工作，并在 `ready` 中等待它们；不要把 marketplace reconcile 或 worker 启动偷偷塞入 core。

### 6.3 PluginServices

```ts
export interface PluginServices {
  readonly extensionSettings: DesktopExtensionSettingsService;
  readonly pluginConfigurations: PluginConfigurationService;
  readonly extensionSourcePolicy: DesktopExtensionSourcePolicy;
  readonly marketplaceEndpoints: MarketplaceEndpointSettingsService;
  readonly marketplaceRegistry: MarketplacePluginRegistry;
  readonly marketplaceCatalog: MarketplaceCatalogService;
  readonly marketplaceInstaller: MarketplacePluginInstaller;
  readonly marketplaceGarbageCollector: MarketplacePluginGarbageCollector;
  readonly generationReferences: MarketplaceGenerationReferenceTracker;
}

export async function createPluginServices(
  context: DesktopRuntimeContext,
  core: Pick<CoreServices, "projects">,
): Promise<PluginServices>;
```

marketplace reconcile 可以由 factory 返回为已完成的 initialization promise，或者由 application 显式 await。不要在构造函数中隐藏磁盘 reconcile。

### 6.4 SessionServices

推荐先保留现有 `SessionSupervisor` 和 registry 的 public 行为，只收敛构造依赖：

```ts
export interface SessionServices {
  readonly metadata: MetadataWorkerClient;
  readonly subagents: SubagentWorkerRegistry;
  readonly workers: ThreadWorkerRegistry;
  readonly sessions: SessionSupervisor;
}

export interface SessionServicePorts {
  /** worker/subagent -> supervisor 的 session event 路由。 */
  publishThreadEvent: (payload: SessionPushPayload, workerId: string, sequence: number) => void;
  publishCatalogChange: (thread: Thread) => void;
  publishWorkerFailure: (projectId: string, threadId: string, error: Error) => void;
  publishResyncRequired: (projectId: string, threadId: string, reason: string) => void;
  log: (scope: string, text: string) => void;
  getWorkspaceKey: (projectId: string) => Promise<string>;
  persistExternalSession: (projectId: string, sessionFile: string, thread: Thread) => Promise<void>;
  handleSubagentHostRequest: (
    request: SubagentHostRequest,
    emit: (event: SubagentRunEvent) => void,
  ) => Promise<unknown>;
  acknowledgeSubagentEvent: (workerId: string, sequence: number) => boolean;
  beginWorkspaceMutation: (workspaceKey: string) => void;
  endWorkspaceMutation: (workspaceKey: string) => void;
  beginProjectMutation: (projectId: string) => void;
  endProjectMutation: (projectId: string) => void;
  beginThreadMutation: (projectId: string, parentThreadId: string) => void;
  endThreadMutation: (projectId: string, parentThreadId: string) => void;
  beginTerminalWorkspaceMutation: (workspaceKey: string) => Promise<() => void>;
  cleanupSessionCheckpoints: (projectId: string, threadIds: readonly string[]) => Promise<void>;
  registerBrowserSession: (identity: BrowserSessionIdentity) => string | undefined;
  revokeBrowserSession: (identity: BrowserSessionIdentity, token: string) => void;
}
```

以上接口按当前 `ThreadWorkerRegistryOptions` 和 `SubagentWorkerRegistryOptions` 的实际依赖分类。实现时仍可将它们拆成 `SessionEventPort`、`SubagentPort`、`WorkspaceMutationPort`、`BrowserCapabilityPort` 和 `PersistencePort`，但每个依赖必须有明确归属，不能只把原有匿名 callback 换一个名字。
```

真正解决循环依赖的重点不是把 `let` 移到 factory，而是先构造稳定 port：

```ts
const routingPort = createSessionRoutingPort();
const subagents = createSubagentServices({ ports: routingPort, ...deps });
const workers = createThreadWorkerServices({ ports: routingPort, subagents, ...deps });
const sessions = new SessionSupervisor(projects, workers, ...);
routingPort.bindSupervisor(sessions);
```

`bindSupervisor` 应只在 bootstrap 阶段可调用一次，并在类型和运行时都拒绝重复绑定。短期如果不引入可绑定 port，也可以通过 `SessionEventRouter` 独立对象承接 worker/subagent 到 supervisor 的事件路由。

### 6.5 WorkspaceServices 和 BrowserServices

```ts
export interface WorkspaceServices {
  readonly scm: ScmService;
  readonly scmWatcher: ProjectScmWatcher;
  readonly fileWatcher: ProjectFileWatcher;
  readonly terminals: TerminalSupervisor;
  readonly officeDocuments: OfficeDocumentPreviewService;
}

export interface BrowserServices {
  readonly data: BrowserDataService;
  readonly manager: BrowserManager;
  readonly hostServer: BrowserHostServer;
}
```

`ThreadWorkerRegistry` 不应直接依赖整个 `TerminalSupervisor` 或 `BrowserManager`。应该传入最小接口：

```ts
interface WorkspaceMutationPort {
  beginTerminalRestore(workspaceKey: string): Promise<() => void>;
}

interface BrowserCapabilityPort {
  register(identity: BrowserSessionIdentity): string | undefined;
  revoke(identity: BrowserSessionIdentity, token: string): void;
}
```

这样 registry 的测试不需要构造完整浏览器和终端服务。

## 7. `index.ts` 的目标形态

重构完成后，入口应接近：

```ts
const application = new DesktopApplication({
  electron: { app, BrowserWindow, Menu, safeStorage },
  window: { dirtyGuard, trayController },
  createRuntimeContext,
  createCoreServices,
  createPluginServices,
  createWorkspaceServices,
  createBrowserServices,
  createSessionServices,
  registerIpc,
});

app.whenReady().then(() => application.start()).catch((error) => {
  console.error("Desktop startup failed:", error);
  app.exit(1);
});

app.on("before-quit", (event) => application.requestQuit(event));
```

实际项目中不必强行把 Electron 依赖全部抽象成接口；测试优先抽象 `DesktopApplication` 的 factory 和 resource scope，Electron window 行为可以继续保留在 `window.ts`。

`index.ts` 应保留的内容：

- 单实例锁和 Electron 顶层事件。
- scheme 的静态注册。
- `DesktopApplication` 创建。
- `app.whenReady`、`before-quit`、`window-all-closed` 的委托。

`index.ts` 不应继续包含：

- marketplace 具体对象的逐个构造。
- ThreadWorkerRegistry 的几十个 callback。
- shell runtime 业务实现。
- Office preview 配置读取细节。
- IPC handler 的领域参数列表。

## 8. 分阶段实施计划

### Phase 0：建立保护网

目标：保证重构只改变组合方式，不改变行为。

任务：

- 为启动阶段添加 `DesktopApplication` 生命周期测试。
- 为 `registerIpc` 添加 named dependency object 的调用测试。
- 固定 startup failure 和 shutdown failure 的日志行为。
- 固定以下现有 contract：
  - `PROTOCOL_VERSION = 10`
  - `SIDECAR_PROTOCOL_VERSION = 3`
  - session attachment / ack / resync 行为
  - marketplace extension generation 行为
- 记录服务的启动和释放顺序。

验收：现有 `./test.sh` 和 Desktop 相关测试通过；没有行为改动。

### Phase 1：拆出 RuntimeContext 和 CoreServices

新增：

- `bootstrap/runtime-context.ts`
- `bootstrap/core-services.ts`

迁移：

- 路径计算。
- shell path 解析。
- `SidecarLog`。
- Project、model、auth、settings、preferences、memory settings、auto-title 等 core service 的构造。

保留：

- 现有 service 构造函数。
- 现有 `index.ts` 启动顺序。

验收：`index.ts` 减少为约 450 行以内；构造服务测试可以不启动 Electron。

### Phase 2：拆出 PluginServices

新增：

- `bootstrap/plugin-services.ts`

迁移：

- extension definitions/settings/policy。
- marketplace endpoint、registry、catalog、installer。
- reconcile、GC、generation references。
- plugin configuration 加密实现的组装。

注意：`MarketplacePluginReconciler.reconcile()` 是启动准备，不应被误认为普通构造。明确由 factory 返回 `ready` promise。

验收：marketplace 相关测试保持通过；插件安装、更新、卸载、GC 的生命周期不变。

### Phase 3：拆出 SessionServices 和显式 ports

新增：

- `bootstrap/session-services.ts`
- `main/session/session-event-router.ts` 或等价 port 模块。

迁移：

- metadata client。
- subagent registry。
- thread worker registry。
- SessionSupervisor。

首先只移动构造代码，不修改 registry 内部算法。然后再替换：

```text
supervisor? 闭包
workers? 闭包
terminals? 闭包
browserManagerInstance? 闭包
```

为：

```text
SessionEventRouter
WorkspaceMutationPort
BrowserCapabilityPort
```

验收：

- session attach、detach、resync、worker failure 测试通过。
- sidecar backpressure 和 sequence ack 测试通过。
- 不再需要“赋值前 callback 必须 ack”的特殊分支，或该分支被限制在 router 内部。

### Phase 4：拆出 Workspace 和 Browser Services

新增：

- `bootstrap/workspace-services.ts`
- `bootstrap/browser-services.ts`

迁移：

- SCM、file watcher、terminal、office preview。
- BrowserDataService、BrowserManager、BrowserHostServer。

浏览器 host server 启动后产生的 endpoint 注入，应由 `BrowserServices` 或 `BrowserCapabilityPort` 完成，不应散落在主入口。

验收：浏览器 webview、browser host、terminal workspace mutation、文件 watcher 测试通过。

### Phase 5：拆 IPC 注册和统一退出资源

新增：

- `bootstrap/ipc-registration.ts`
- `main/ipc/session-ipc.ts`
- `main/ipc/browser-ipc.ts`
- `main/ipc/settings-ipc.ts`
- `main/ipc/plugin-ipc.ts`
- `main/ipc/workspace-ipc.ts`

第一步只拆注册函数，不修改 channel 名称和 handler 逻辑。第二步将 `registerIpc` 改为 named dependency object。

同时引入：

```ts
interface DisposableResource {
  dispose(): void | Promise<void>;
}

class ResourceScope implements DisposableResource {
  add(resource: DisposableResource): void;
  dispose(): Promise<void>;
}
```

资源 scope 需要支持单个资源失败后继续释放其余资源，并聚合错误；但不应仅按注册顺序的逆序释放所有资源。当前服务存在 worker drain、异步 host server、watcher 和跨域回调，关闭顺序必须显式声明。

建议使用依赖感知的 shutdown phases：

1. 标记 application 为 `stopping`，拒绝新的 IPC、session attach 和后台任务。
2. 停止 updater、marketplace GC、文件/SCM watcher 和 shell install progress。
3. 撤销 browser capability，停止 browser host 接收新请求，再关闭 browser manager。
4. 停止 terminal 新建请求，等待或结束 terminal sessions。
5. drain 并关闭 thread workers、subagent workers 和 SessionSupervisor subscriptions。
6. 关闭 metadata worker，最后关闭 sidecar log。

每个 phase 内可以并行释放互不依赖的资源；跨 phase 必须等待前一阶段完成。`ResourceScope` 可以负责登记资源、幂等和错误聚合，但关闭顺序应由 `DesktopApplication.dispose()` 或命名的 phase 负责。

验收：

- quit、reload、second-instance 行为不变。
- 所有 worker 和 watcher 均已释放。
- shutdown 超时和失败日志可定位到资源名称。

## 9. 测试策略

### 9.1 Factory 单元测试

每个 factory 至少覆盖：

- 正常依赖图。
- 前置异步任务失败。
- 中间服务构造失败时已创建资源的清理。
- optional capability 缺失时的降级。
- dispose 幂等。

### 9.2 Application 生命周期测试

覆盖：

- initialize → start。
- initialize 失败不会创建窗口。
- IPC 只注册一次。
- startup 后 quit。
- dirty window 阻止首次 quit，并在确认后继续。
- factory 之间失败回滚。
- IPC 注册失败回滚。
- `start()` 失败后的再次 `dispose()`。
- `dispose()` 期间重复收到 `before-quit`。
- 已创建 browser host、worker、watcher 后，后续 factory 失败时的释放顺序。

Application 需要显式维护初始化状态，例如 `new`、`initializing`、`ready`、`starting`、`running`、`stopping`、`stopped`。`dispose()` 必须允许在任意已部分初始化状态执行，并且幂等。

### 9.3 依赖方向检查

加入静态检查或测试，禁止：

```text
main/domain service -> main/bootstrap
renderer -> main
sidecar -> main/bootstrap
```

这里的 sidecar 规则必须具体化，而不是笼统地禁止所有 sidecar 到 main 的依赖。当前 sidecar 代码已经使用少量可复用的 `main` 运行时代码，例如路径、Pi runtime 和 extension policy；迁移期间应先建立允许清单：

```text
sidecar -> shared
sidecar -> main/pi 的纯运行时适配模块
sidecar -> main/path 等无 Electron 依赖的纯模块
sidecar -/-> main/bootstrap
sidecar -/-> main/index
sidecar -/-> BrowserWindow / ipcMain / app
```

可使用 TypeScript project references、ESLint boundary rule 或脚本检查实现约束。bootstrap 只能被主进程入口和测试使用。

### 9.4 运行时回归

至少保留并运行以下现有测试类别：

- `sidecar-*`
- `session-*`
- `worker-client-*`
- `browser-host-*`
- `browser-manager-*`
- `terminal-supervisor-*`
- `plugin-marketplace-*`
- `renderer-boundaries.test.ts`
- `packaged-gui-smoke.test.ts`

代码变更后按项目规则运行 `npm run check`；不运行 `npm test` 或完整 Vitest，除非另行请求。

## 10. 风险和不应做的事情

### 10.1 不要一次重写 registry

`ThreadWorkerRegistry` 已经同时处理 worker capacity、session lifecycle、extension replacement、mutation lock 和 subagent integration。把它与入口重构绑定会使故障定位困难。先移动组合代码，再改变 port，最后才考虑拆 registry 内部职责。

### 10.2 不要把所有依赖包进一个 `Container`

通用 service locator 只能隐藏依赖，不能解决依赖方向。factory 返回按领域分组的 typed services，领域类继续使用显式 constructor dependencies。

### 10.3 不要让 factory 隐藏重要异步操作

以下操作必须在调用处可见或由命名方法表达：

- 项目加载。
- ModelRuntime 创建。
- marketplace reconcile。
- browser host server 启动。
- worker dispose。

推荐 `createPluginServices()` 返回已准备好的结果，或者暴露 `ready`，不要在普通 `new` 语义中启动后台任务。

### 10.4 不要改变数据所有权

重构期间保持：

- Pi session 文件仍是会话事实来源。
- metadata 是索引投影。
- renderer cache 是 UI 投影。
- marketplace registry 是插件安装状态来源。
- worker 仍是单 session AgentSession 的所有者。

## 11. 完成标准

重构完成后应满足：

- `src/main/index.ts` 只负责 Electron 顶层生命周期和 application 委托。
- 领域服务可以在不启动 BrowserWindow 的测试中构造。
- `registerIpc` 使用命名依赖对象，且按领域拆分内部注册器。
- session worker、subagent、browser、terminal 的跨域连接通过显式 port 表达。
- 不再使用未赋值局部变量表达服务可用性。
- 退出流程由统一资源 scope 管理，支持幂等和错误聚合。
- IPC、sidecar、session、plugin marketplace 的 public behavior 和 protocol version 不变。
- `npm run check` 通过，相关 Desktop 测试和打包 smoke test 通过。

## 12. 建议的首个实现任务

第一步只实施 Phase 1：新增 `bootstrap/runtime-context.ts` 和 `bootstrap/core-services.ts`，把 `index.ts:229-356` 的路径、shell、项目、模型、配置服务构造迁移出去。

这个切入点风险最低，因为它不触碰：

- SessionSupervisor 与 worker registry 的回调闭环。
- sidecar wire protocol。
- renderer attachment。
- IPC channel 行为。
- browser webview 生命周期。

完成后再以 Phase 1 的返回类型作为后续 plugin/session factory 的边界。 
