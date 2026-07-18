# Desktop Node Sidecar 架构规范

状态：Proposed
最后更新：2026-07-18

## 1. 背景

### 1.1 问题

Desktop `build:pi` 在共享 `packages/coding-agent/node_modules` 上执行 Electron ABI 重建（`scripts/rebuild-desktop-native.mjs`），原地将 `better-sqlite3` 等原生模块从 Node ABI 137 改为 Electron ABI 148。普通 Pi CLI 随后加载同一 `~/.pi/agent/npm/node_modules/better-sqlite3` 时报错，两种 ABI 互相覆盖。

### 1.2 约束

- 用户扩展来自共享 `~/.pi/agent/npm`（非 Desktop 声明的依赖），仅隔离 `packages/desktop/node_modules` 不能修复
- 项目级 `.pi/npm` 和本地路径扩展也可能携带原生模块
- Desktop 架构约束：外部扩展可原样调用 `pi`（RPC/JSON/TUI），worker 必须路由到内置 runtime，禁止外部回退
- Desktop 定位：为 Pi Coding Agent 现有能力提供可视化 UI 与交互适配，不在 Desktop 侧重新发明功能/产品逻辑

### 1.3 方案选择

**已选择：每 live thread 一个普通 Node sidecar + metadata worker。**

备选方案及排除原因：
- 独立 Electron 扩展缓存：只能处理 `~/.pi/agent/npm`，还要额外处理项目级和本地扩展
- 单应用 sidecar：迁移成本最低但不是隔离最优，崩溃面覆盖所有 Pi sessions
- 普通 Node `child_process.fork` 显式 execPath：将 Pi 运行时完整移出 Electron 主进程，一次解决所有原生依赖

## 2. 架构拓扑

```text
Electron main
├── 文件服务（FileService，保留在主进程）
├── 终端管理（TerminalSupervisor，保留在主进程）
├── 窗口 / IPC / ProjectStore（保留在主进程）
├── ThreadWorkerRegistry
│   ├── thread A -> Node sidecar A -> SessionRuntime A
│   ├── thread B -> Node sidecar B -> SessionRuntime B
│   └── thread C -> Node sidecar C -> SessionRuntime C
└── Metadata worker（长生命周期或按需启动）
    ├── SessionManager.list()
    ├── cold session rename / remove / archive
    └── DraftSessionConfig
```

### 2.1 职责切面

| 层 | 职责 | 不负责 |
|---|---|---|
| Electron main | attachment 订阅、`webContents.id` 过滤、窗口管理、文件服务、PTY、ProjectStore、IPC 路由 | Pi runtime、扩展加载、SessionManager 文件 I/O |
| Thread worker（Node sidecar） | Pi `SessionRuntime`、扩展 HostUi、`SessionManager` 打开/写入当前 thread、projection 事件批处理 | 窗口、renderer attachment、文件服务 |
| Metadata worker | `SessionManager.list()`、cold rename/remove/archive、draft config | 已加载 thread 的写入 |

### 2.2 所有权规则

1. **已加载 thread 的写入必须转发给对应 thread worker**。若 thread 已在 `ThreadWorkerRegistry` 中，`rename/remove` 由该 worker 执行，metadata worker 不得写入同一文件
2. **cold session 的元数据操作由 metadata worker 执行**。`list()` 返回的 thread 信息中，live threads 通过 registry 补充控制状态
3. **同一 thread 不能同时被两个 worker 打开**。创建 worker 前 registry 先原子登记 threadId，重复创建返回已有 worker

## 3. 协议设计

### 3.1 现有协议基础

Renderer 与 Electron main 之间已只传 `contracts.ts` 中的 JSON 型数据。Thread worker 迁移复用此基础：

```text
Renderer
  -> Electron main IPC（contracts.ts JSON）
  -> ThreadWorkerRegistry 路由
  -> Node sidecar IPC（WorkerEnvelope / WorkerCommand）
  -> SessionRuntime
```

### 3.2 Worker 命令

基于现有 `WorkerCommand` 类型扩展：

```typescript
// 新增命令
type WorkerCommand =
  | { type: "start"; input: StartThreadInput }        // 创建 SessionRuntime
  | { type: "prompt"; input: SessionPromptInput }     // 发送用户提示
  | { type: "edit"; input: SessionEditInput }          // 编辑消息
  | { type: "cancel" }                                 // 取消运行
  | { type: "approval"; response: HostResponse }       // 审批响应
  | { type: "rename"; title: string }                  // 重命名（仅本 thread）
  | { type: "remove" }                                 // 删除（仅本 thread）
  | { type: "dispose" }                                // 关闭 worker
```

### 3.3 Worker 响应 / 推送

```typescript
type WorkerResponse =
  | { type: "started"; bootstrap: SessionBootstrap }
  | { type: "push"; payload: SessionPushPayload }
  | { type: "control"; state: SessionControlState }
  | { type: "hostRequest"; request: HostRequest }
  | { type: "disposed" }
  | { type: "error"; message: string; code?: string }
```

### 3.4 传输层

使用普通 Node `child_process.fork` + IPC（`process.send` / `message` 事件），序列化为 JSON。不引入额外传输协议。

关键约束：`HostRequest` 包含需要 Electron main 响应（dialog、webview panel 创建等）的请求，worker 发送后阻塞等待 `HostResponse`。实现上为异步 request-response 配对，支持超时。

## 4. 生命周期

### 4.1 Thread worker 创建

```text
Renderer: sessions.create(input)
  -> Electron main: SessionSupervisor.createThread()
  -> ThreadWorkerRegistry.getOrCreate(threadId)
  -> fork(nodeExecPath, [workerEntry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })
  -> worker: createAgentSessionServices() -> createAgentSessionFromServices()
  -> worker: send({ type: "started", bootstrap })
  -> Electron main: 转发 bootstrap 到 renderer
```

### 4.2 Thread worker 销毁

触发条件：
1. Renderer 关闭 thread / 切换 project
2. Thread 空闲超时（可配置，默认不启用）
3. Worker 进程崩溃

销毁流程：
```text
Electron main: registry.dispose(threadId)
  -> worker: send({ type: "dispose" })
  -> worker: session.dispose() -> process.exit(0)
  -> Electron main: 从 registry 移除，通知 renderer control state 变为 disposed
```

### 4.3 崩溃恢复

1. Worker 进程意外退出 -> registry 检测 `exit` 事件
2. 将 thread 标记为 `crashed`，通知 renderer 显示错误状态
3. Renderer 可选择 `reload`：重新创建 worker，replay 最近 timeline（只读恢复，不重放变更命令）
4. 崩溃 generation 递增，防止旧的 in-flight 响应污染新 worker

### 4.4 Metadata worker 生命周期

- 首次 metadata 请求时延迟创建（`list()`、draft config、cold rename/remove）
- 与应用同生命周期，崩溃时自动重建
- 或使用短生命周期：每次 metadata 请求 fork 新进程，完成后退出（启动开销低于常驻内存）

决策：优先使用**常驻 metadata worker**，与 `app.on("will-quit")` 一起销毁。若后续发现内存问题再改为按需短生命周期。

## 5. 协议版本

`PROTOCOL_VERSION` 继续由 `contracts.ts` 管理。Worker 启动时在 `started` 响应中宣告其协议版本，Electron main 校验兼容性。版本不匹配时拒绝连接并提示升级。

## 6. 线程安全与并发

### 6.1 SessionManager 文件并发

- 每个 thread worker 持有自己的 `SessionManager` 实例
- 同一 thread 不会被两个 worker 同时打开（registry 原子登记）
- Metadata worker 只读 `list()`（遍历目录元数据），不打开 session 文件
- Cold rename/remove 在 metadata worker 执行前先检查 registry，确认 thread 未加载

### 6.2 跨 thread 操作

当前 Pi 没有跨 thread 依赖（thread 完全独立）。若未来引入 `fork` 等操作，由 Electron main 协调源 worker 和目标 worker。

## 7. Node 可执行文件发现

### 7.1 开发环境

使用 `process.execPath`（即 Electron），通过 `ELECTRON_RUN_AS_NODE=1` 环境变量使 Electron 以普通 Node 模式运行子进程。原生模块加载使用 Node ABI（非 Electron ABI）。

### 7.2 打包环境

选项 A（优先）：捆绑 Node binary
- 在 extraResources 中包含 Node binary
- worker fork 时使用 bundled Node 路径
- 优点：ABI 完全受控，不受用户 Node 版本影响
- 缺点：增加包体积约 40-60 MB

选项 B：使用系统 Node
- 运行时发现系统 Node（`which node` 或 `process.env.PATH`）
- 校验 ABI 兼容性，不匹配时报错
- 优点：零额外体积
- 缺点：依赖用户环境，ABI 可能不匹配

**决策：优先选项 A（捆绑 Node），fallback 选项 B。** 最终决策在实施前确认。

### 7.3 macOS PATH 环境

GUI 应用通过 Dock/Finder 启动时继承的 `PATH` 不包含用户 shell 配置（`.zshrc`、`.bash_profile`）。需要在 worker fork 前显式读取用户 shell 环境或使用 bundled Node。

## 8. 扩展依赖策略

### 8.1 共享扩展发现语义

Desktop 与 CLI 共享相同的扩展发现路径：
- `~/.pi/agent/npm`（全局扩展）
- `<project>/.pi/npm`（项目级扩展）
- `<project>/.pi/extensions/`（本地路径扩展）

`DefaultResourceLoader` 和 `ExtensionLoader` 继续使用这些路径。

### 8.2 原生模块 ABI 校验

Node sidecar 运行在普通 Node ABI 下，扩展原生模块必须兼容 Node ABI（而非 Electron ABI）。

1. Worker 启动时扫描已安装扩展的原生模块
2. 尝试 `require()` 加载，失败时报告具体模块和 ABI 不匹配信息
3. **绝不原地 rebuild**：ABI 不匹配的扩展报告错误并跳过加载，不执行 `npm rebuild`
4. 用户在终端用 Pi CLI 安装的扩展已兼容 Node ABI，在 Desktop 中可直接使用

### 8.3 打包版扩展策略

Desktop 打包版不捆绑用户扩展。用户扩展继续通过 `pi install` 在终端管理，Desktop 自动发现。

## 9. 打包配置

### 9.1 electron-builder 配置

```yaml
extraResources:
  - from: resources/node
    to: node
    filter:
      - "**/*"
  - from: out/main
    to: workers
    filter:
      - coding-agent-node-sidecar-worker.js
      - chunks/**
```

### 9.2 worker 入口构建

Worker entry 在 `electron-vite.config.ts` 中作为独立入口构建：

```typescript
// electron.vite.config.ts
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "coding-agent-node-sidecar-worker": resolve("src/main/pi/worker-entry.ts"),
        },
      },
    },
  },
});
```

Worker 入口打包为 CJS（Node `child_process.fork` 默认使用 CJS），仅包含 worker 所需依赖，不引入 Electron runtime。

## 10. 迁移阶段

### 阶段一：基础设施（不改产品行为）

1. 创建 `packages/desktop/src/main/pi/worker-entry.ts`（worker 入口）
2. 实现 `ThreadWorkerRegistry`（进程管理、路由、崩溃恢复）
3. 实现 metadata worker（或复用 `ThreadWorkerRegistry` 创建短生命周期进程）
4. 从 `SessionSupervisor` 抽取纯 Electron 职责（attachment 订阅、IPC 路由），Pi runtime 调用改为通过 registry 转发
5. 保留 `SessionSupervisor` 作为 facade，内部委托给 registry
6. 更新 `electron.vite.config.ts` 多入口构建
7. 更新 `electron-builder.yml` extraResources
8. 移除 `scripts/rebuild-desktop-native.mjs` 和 `build:pi` 中的 rebuild 步骤

### 阶段二：产品语义对齐（可并行或后置）

1. Metadata worker 的 cold session 操作与 registry 协调
2. 崩溃恢复 UX（错误提示、reload 按钮）
3. 空闲 worker eviction（可选）
4. 跨 worker 操作支持（如 thread fork，按需）

## 11. 对现有规范的影响

- `pi-native-assistant-ui-runtime-spec.md`：renderer 侧 `PiThreadStore`、`useExternalStoreRuntime` 和 assistant-ui 集成不变。唯一变更是 Electron main 侧的 push 事件来源从 `SessionRuntime` 直接订阅变为通过 worker IPC 中继
- `new-session-draft-spec.md`：draft config 读取路径从 `SessionSupervisor` 直接调用变为通过 metadata worker，产品语义不变
- `assistant-ui-thread-attach-spec.md`：已标记 Superseded，无影响

## 12. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Worker 进程启动慢（需加载 Pi、模型注册表、扩展） | 中 | 首个 prompt 延迟 2-5s | 启动后立即预热；metadata worker 常驻；可考虑 worker 预热池 |
| Worker 内存开销高（每进程 ~150-300 MB RSS） | 高 | 多个 thread 时总内存过高 | 空闲 worker eviction；用户通常同时只活跃 1-2 个 thread |
| `ELECTRON_RUN_AS_NODE` 在打包 asar 中无法直接执行 worker 入口 | 中 | 打包版启动失败 | electron-builder extraResources 将 worker 入口和 chunks 解压到 asar 外 |
| IPC 背压（高频 timeline 事件） | 低 | renderer 落后或丢帧 | 现有 `PiThreadProjector` 批处理已合并高频事件；worker 侧 throttle 可选 |
| Metadata worker 和 thread worker 同时操作同一 session 文件 | 低 | 数据损坏 | Registry 原子登记 + 操作前检查 |
| 用户同时用 CLI 和 Desktop 打开同一 session | 中 | 数据竞争 | 第一阶段不处理（与现状一致）；后续引入 file lock 或 lease |

## 13. 验收标准

1. `build:pi` 不再执行任何 native rebuild 步骤
2. 普通 Pi CLI 在 Desktop build 后 `better-sqlite3` 仍可正常加载
3. Desktop 创建 thread、发送 prompt、接收 stream 响应功能不变
4. 扩展（含 `pi-hermes-memory` 的 `better-sqlite3`）在 Desktop 中正常工作
5. Worker 崩溃时 renderer 显示错误状态，可 reload
6. 多个 thread 并发运行互不干扰
7. 现有测试套件通过（可能需要适配 mock）

## 14. 待确定决策

实施前需确定：

1. **Bundled Node 版本及平台矩阵**：捆绑哪个 Node 版本（建议与 Electron 内置 Node 主版本一致），支持哪些平台
2. **Desktop 私有依赖树策略**：是否需要在 `packages/desktop/node_modules` 之外维护独立的依赖安装树
3. **CLI 与 Desktop 同时打开同一 session 的 lease 规则**：第一阶段保持现状（无锁），后续是否引入 file lock

## 15. 参考

- 现有 worker 实现（meta-agent-harness）：`apps/desktop/src/main/coding-agent/node-sidecar-worker-main.ts`、`packages/coding-agent-desktop/src/worker/runtime-factory.ts`
- Pi SDK：`packages/coding-agent/src/core/session-manager.ts`、`packages/coding-agent/src/core/extensions/loader.ts`
- Electron 文档：`child_process.fork`、`ELECTRON_RUN_AS_NODE`、`utilityProcess`、`extraResources`