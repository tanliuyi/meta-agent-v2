# Desktop Node Sidecar 规范

状态：Accepted
最后更新：2026-07-18

## 1. 目标

Desktop 将 Pi runtime 放在普通 Node sidecar 中运行，每个 live thread 一个 worker，metadata 使用独立 worker。Electron main 只负责 IPC、窗口、项目状态和 worker 生命周期。

Desktop 与 Pi CLI 继续共享 `agentDir`、Project `.pi` 配置以及 model、auth、settings、prompt、skill 和 session JSONL 语义。

Extension 来源改由 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 负责：Desktop 禁止 Pi 默认 global/project extension discovery，只加载内建 inline、同仓精选和 Developer Mode 显式批准的 entry。Desktop 不复制、安装或重建 extension 依赖，不修改共享 npm tree，也不加载 Electron native addon。

## 2. Node runtime

sidecar 必须使用用户系统中的普通 Node，版本要求 `>=22.19.0`。探测顺序为：

1. `PI_DESKTOP_NODE_EXEC_PATH`；
2. Desktop 用户级安装目录中的 active Node；
3. 当前进程 `PATH` 中的 `node`。

启动前校验 Node 版本、platform、arch 和 modules ABI。禁止使用 Electron `process.execPath`、`utilityProcess`、`ELECTRON_RUN_AS_NODE=1` 或 shell 猜测 PATH。

打包版 `runtime-manifest.json` 使用 `nodePath: "system"`，不包含 Node executable、npm CLI 或 native runtime。sidecar JS 位于 `app.asar.unpacked` 的真实文件系统，并通过 manifest 校验。

## 3. 缺失 Node 的一键安装

如果没有可用 Node，main 仍创建窗口，但 renderer 显示阻断式 NodeRuntime 面板，禁止进入会话 UI。面板显示最低版本、当前阶段、百分比、错误信息和重试按钮。

点击安装后：

1. 从 Node 官方 distribution 下载固定版本 archive；
2. 按平台和架构选择 darwin arm64/x64、linux arm64/x64 或 win32 arm64/x64 包；
3. 下载过程中发送 `checking`、`downloading`、`verifying`、`extracting`、`ready` 或 `error` 进度；
4. 校验固定 SHA-256，不接受校验失败的文件；
5. 解压到 `<userData>/node-runtime`，使用 staging 目录和原子 `active.json`；
6. 安装成功后自动重启 Desktop，重启后 sidecar 直接使用该 Node。

安装器不需要用户打开终端、选择目录或确认脚本。失败时删除 staging，保留 cache 和错误原因，用户可再次点击重试。

## 4. Sidecar topology

```text
Renderer -> preload -> Electron main
                         |-> ThreadWorkerRegistry
                         |    |-> thread A ordinary Node
                         |    |-> thread B ordinary Node
                         |-> MetadataWorkerClient
                         |-> ProjectStore / files / PTY
```

每个 thread worker 只持有一个 `SessionRuntime` 和一个 live `AgentSession`。worker 崩溃只影响当前 thread；恢复只能通过新 worker 和 fresh bootstrap，不自动重放 prompt、edit、reload、cancel、compact 或其他有副作用命令。

metadata worker 只处理 catalog、draft 配置和 cold session metadata，不打开 registry 中的 live session。live rename/remove 必须路由给对应 thread worker并串行化。

## 5. Extension loading

sidecar 使用 Pi `ResourceLoader`，但设置 `noExtensions: true`。main-owned source policy 将受控的精确 entry 列表作为 `additionalExtensionPaths` 传入，Desktop 内建 provider 继续使用 inline `extensionFactories`。

Desktop 不执行 lifecycle script approval，也不在缺依赖时自动安装或 rebuild；缺依赖直接返回可诊断错误。具体来源、Developer Mode、Host Profile 和 worker generation 规则以 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 为准。

## 6. IPC 和生命周期

- sidecar wire protocol 独立于 renderer protocol，带 protocol version、worker instance、request correlation 和 event sequence；
- request/response 必须 settle exactly once；worker exit 拒绝 pending request；
- timeline 队列有上限、ACK/credit 和 resync；
- attach 使用 token，迟到事件不能污染新 thread；
- graceful shutdown 超时后 TERM/KILL，退出后不得留下 orphan child；
- Electron 单实例锁和 registry single-flight 保证 Desktop 内同一 thread 只有一个 writer；确认旧 child 退出前不得启动替代 worker；
- CLI 与 Desktop 首期不保证同时写同一 session。

## 7. 当前实现文件

- `src/main/sidecar/node-runtime-locator.ts`：Node 探测、版本和 manifest；
- `src/main/sidecar/node-runtime-installer.ts`：下载、校验、解压和进度；
- `src/main/index.ts`、`src/main/ipc.ts`、`src/preload/index.ts`：生命周期和 IPC；
- `src/renderer/src/App.tsx`、`src/renderer/src/styles/components.css`：阻断面板；
- `src/main/sidecar/thread-worker-registry.ts`、`src/sidecar/thread-worker-service.ts`：thread worker；
- `src/main/sidecar/metadata-worker-client.ts`、`src/sidecar/metadata-worker-service.ts`：metadata worker；
- `scripts/generate-desktop-sidecar-manifest.mjs`：开发/打包 manifest；
- `scripts/validate-desktop-package.mjs`、`scripts/smoke-desktop-sidecar.mjs`：产物校验。

## 8. 验证与发布门槛

代码修改后运行：

```sh
npm run check
```

桌面产物验证：

```sh
npm --prefix packages/desktop run package
npm --prefix packages/desktop run smoke:sidecar -- --artifact <resources-or-app>
npm --prefix packages/desktop run smoke:gui -- --artifact <app> --mode both
```

验收必须确认：

- packaged manifest 的 `nodePath` 为 `system`，npm CLI 和 Node integrity 为空；
- 安装包不包含内置 Node 或 `node-runtime` 目录；
- 无 Node 时 renderer 阻断并可一键完成安装和自动重启；
- Desktop 不会发现未批准的 Pi global/project extension，受控 entry、inline factories、skills 和 prompt templates 正常加载；
- sidecar smoke、GUI smoke、focused tests 和根级 `npm run check` 通过。

## 9. 非目标

- 不实现 Electron 专用 native dependency tree；
- 不生成依赖投影，也不执行投影垃圾回收；
- 不在 Desktop 中执行 npm install/rebuild/lifecycle approval；
- 不把 renderer 直接连接到 sidecar；
- 不修改 Pi session JSONL schema。
