# Desktop Electron Embedded Node Sidecar 规范

状态：Accepted（extension 分发与安装部分已被后续规范取代）
最后更新：2026-07-29

[`plugin-marketplace-product-spec.md`](./plugin-marketplace-product-spec.md) 已接受并取代本文中 extension source 仅限 builtin/curated/Developer Mode、Desktop 不复制/安装 extension dependency、不加载 native addon，以及不建设 extension 安装生命周期的相关条款。Marketplace 是第四类 main-approved entry。Electron embedded Node runtime compatibility、`noExtensions: true`、main-owned entry set 和 worker 生命周期要求继续有效。

## 1. 目标

Desktop 将 Pi runtime 放在 Electron embedded Node sidecar 中运行，每个 live thread 一个 worker，metadata 和 programmatic subagent 使用独立 worker。Electron main 负责 IPC、窗口、项目状态和 worker 生命周期。

Desktop 与 Pi CLI 继续共享 `agentDir`、Project `.pi-desk` 配置以及 model、auth、settings、prompt、skill 和 session JSONL 语义。

Extension 来源由 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 负责：Desktop 禁止 Pi 默认 global/project extension discovery，只加载内建 inline、同仓精选、Marketplace 和 Developer Mode 显式批准的 entry。

## 2. Embedded Node runtime

sidecar 只使用当前 Electron executable 内嵌的 Node。main 通过以下固定方式启动所有 role entry：

```ts
fork(entry, [], {
  execPath: process.execPath,
  env: { ...filteredEnvironment, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
  serialization: "json",
  detached: process.platform !== "win32",
  windowsHide: true,
});
```

不探测系统 Node，不读取 PATH 或 runtime override，不下载 managed Node，也不使用 `utilityProcess`。`ELECTRON_RUN_AS_NODE` 只设置在 sidecar child environment，不能污染 Electron GUI main process。

`runtime-manifest.json` 只包含 role entry、entry/runtime asset hashes 和 runtime compatibility。开发及打包 manifest 都通过安装的 Electron executable 在 `ELECTRON_RUN_AS_NODE=1` 下探测 compatibility。main 在启动 worker 前将 manifest compatibility 与当前 Electron main process 核对。

打包 sidecar JS 必须位于 `app.asar.unpacked` 的真实文件系统。安装包不得包含独立 `node-runtime`、Node executable 或 npm CLI。RunAsNode fuse 必须保持启用，产物验证必须实际执行 embedded Node probe。

## 3. Git Bash

Git Bash 是独立 shell dependency，不属于 sidecar Node runtime。Windows 保留首次启动阻断、Git-for-Windows 检测、PortableGit 下载、用户选择、自定义 `shellPath` 持久化和 SHA-256 校验。非 Windows 不显示 shell dependency gate。

installer `--runtime-setup` 只接受 `shell`。现有自定义有效 Git Bash 必须保留；应用内显式安装或选择后可更新有效 scope 的 `shellPath`。

## 4. Sidecar topology

```text
Renderer -> preload -> Electron main
                         |-> ThreadWorkerRegistry
                         |    |-> Electron-as-Node thread A
                         |    |-> Electron-as-Node thread B
                         |-> MetadataWorkerClient -> Electron-as-Node metadata
                         |-> SubagentWorkerRegistry -> Electron-as-Node subagent
                         |-> ProjectStore / files / PTY
```

每个 thread worker 只持有一个 `SessionRuntime` 和一个 live `AgentSession`。worker 崩溃只影响当前 thread；恢复只能通过新 worker 和 fresh bootstrap，不自动重放有副作用命令。

metadata worker 只处理 catalog、draft 配置和 cold session metadata。live rename/remove 必须路由给对应 thread worker 并串行化。

sidecar descendants that launch `process.execPath` inherit `ELECTRON_RUN_AS_NODE=1` through the normal Node child-process environment. Desktop-owned spawn boundaries must not replace that environment. Third-party code that replaces its complete environment is outside Desktop's spawn contract.

## 5. Extension loading

sidecar 使用 Pi `ResourceLoader`，但设置 `noExtensions: true`。main-owned source policy 将受控精确 entry 列表作为 `additionalExtensionPaths` 传入，Desktop 内建 provider 继续使用 inline `extensionFactories`。

Desktop 不执行 lifecycle script approval，也不在缺依赖时自动 install 或 rebuild。Marketplace artifact target 必须匹配 Electron embedded Node 的 version、modules ABI、N-API、platform、arch 和 runtime compatibility ID。具体来源、Developer Mode、Host Profile 和 worker generation 规则以 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 为准。

## 6. IPC 和生命周期

- sidecar wire protocol 独立于 renderer protocol，带 protocol version、worker instance、request correlation 和 event sequence；
- request/response 必须 settle exactly once；worker exit 拒绝 pending request；
- timeline 队列有上限、ACK/credit 和 resync；
- attach 使用 token，迟到事件不能污染新 thread；
- graceful shutdown 超时后 TERM/KILL；POSIX 使用 detached process group，Windows 使用 `taskkill /T /F`；
- 退出后不得留下 worker、watchdog、Pi child 或 extension descendant orphan；
- Electron 单实例锁和 registry single-flight 保证同一 thread 只有一个 writer。

## 7. 当前实现文件

- `src/main/sidecar/sidecar-runtime-manifest.ts`：artifact manifest、hash 和 embedded runtime compatibility 校验；
- `src/main/sidecar/worker-client.ts`：Electron-as-Node fork、protocol 和 process-tree lifecycle；
- `src/main/sidecar/thread-worker-registry.ts`、`src/sidecar/thread-worker-service.ts`：thread worker；
- `src/main/sidecar/metadata-worker-client.ts`、`src/sidecar/metadata-worker-service.ts`：metadata worker；
- `src/main/sidecar/subagent-worker-registry.ts`、`src/sidecar/subagent-worker-service.ts`：subagent worker；
- `src/main/sidecar/shell-runtime-*.ts`、`src/renderer/src/features/shell-runtime`：Windows Git Bash flow；
- `scripts/generate-desktop-sidecar-manifest.mjs`：Electron compatibility manifest；
- `scripts/validate-desktop-package.mjs`、`scripts/smoke-desktop-sidecar.mjs`、`scripts/smoke-desktop-gui.mjs`：产物验证。

## 8. 验证与发布门槛

代码修改后运行 focused tests、Desktop typecheck 和：

```sh
npm run check
```

桌面产物验证：

```sh
npm --prefix packages/desktop run package
npm --prefix packages/desktop run smoke:sidecar -- --artifact <app>
npm --prefix packages/desktop run smoke:gui -- --artifact <app> --mode both
```

验收必须确认：

- manifest compatibility 等于 packaged Electron embedded Node；
- 所有 worker 使用 packaged Electron executable 和 unpacked role entry；
- manifest 和安装包均不包含 external/managed Node 或 npm CLI；
- RunAsNode、`node:sqlite`、protocol ready/ping/shutdown 和 no-orphan checks 通过；
- Git Bash install/select/custom path 行为保持；
- curated、Marketplace、Developer Mode 和 builtin extensions 在相同 approved entry set 下加载。

## 9. 非目标

- 不提供 external/system/managed Node fallback；
- 不实现 Electron 专用 extension dependency tree；
- 不在 Desktop 中执行 npm install/rebuild/lifecycle approval；
- 不把 renderer 直接连接到 sidecar；
- 不修改 Pi session JSONL schema。
