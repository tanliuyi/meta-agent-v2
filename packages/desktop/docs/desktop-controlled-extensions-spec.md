# Meta Agent Desktop 受控扩展规范

> 状态：Draft
>
> 适用范围：`packages/desktop` 与 Pi extension runtime 集成
>
> 目标版本：Desktop Extension Host Profile v1

## 1. 摘要

Meta Agent Desktop 保留 Pi extension 机制作为 agent runtime 的扩展执行底座，但不承诺兼容任意 Pi TUI、RPC 或本地 extension。

Desktop 只加载以下来源：

1. Desktop 内建 inline extensions；
2. 与 Desktop 同仓库、同版本、同发布周期的精选 extensions；
3. 用户显式开启 Developer Mode 后批准的本地开发 extension。

Desktop 不建设在线 packages center，不提供第三方扩展的发现、下载、签名、认证、自动更新或撤销服务。

Pi extension runner 继续负责 tools、commands、events、providers 和 session 集成。Desktop 只负责控制允许加载的 entry，并提供明确、有限、可测试的 Host UI Profile。

核心定位：

```text
Pi Extension API
    = 扩展执行 ABI

Desktop Extension Source Policy
    = 决定允许加载哪些 extensions

Desktop Extension Host Profile
    = Desktop 真实支持的 UI 和 command-context 能力子集
```

“Pi 可以加载”不等于“Desktop 保证兼容”。只有 Desktop 内建或精选 extension 属于产品支持范围；Developer Mode extension 属于用户自行信任、best-effort 运行范围。

## 2. 架构决策

本规范确定以下决策：

1. 保留 Pi `AgentSession`、`ResourceLoader`、extension runner 和 public extension API。
2. Desktop 不重写 extension registration、event dispatch、tool execution、queue 或 agent loop。
3. 默认禁止 Pi user/project extension 自动发现。
4. live session 与 draft metadata 使用相同的 extension source policy。
5. Desktop 内建 extension 使用 `extensionFactories`。
6. Desktop 精选 extension 使用只读、版本锁定的 bundled entry paths。
7. Developer Mode extension 必须由用户逐项显式批准，不扫描目录自动加载。
8. extension 代码只在 Node sidecar 中执行：live session 使用 thread worker，draft discovery 使用 metadata worker；Electron main、preload 和 renderer 不导入 extension 代码。
9. 每个 thread worker generation 使用不可变 extension set。
10. extension set 变化通过 replacement worker 生效，不在运行中的 worker 内热替换代码。
11. Desktop v1 只实现声明式 Host UI，不复刻 Pi TUI。
12. 不支持的 API 必须明确失败或按本规范定义降级，不得返回伪成功。
13. Developer Mode 是信任开关，不是安全 sandbox。
14. extension 配置与 session timeline 分离，不写入 Pi conversation context。
15. 当前不为未来扩展中心预建 catalog、installer、publisher 或 artifact registry。

### 2.1 规范优先级

本规范是以下 extension 相关决策的新 authority，并明确取代旧规范中的冲突要求：

- 取代 [`node-sidecar-per-thread-spec.md`](./node-sidecar-per-thread-spec.md) 中 Desktop 与 Pi CLI 必须共享 extension 来源、enabled state 和 discovery order 的要求。skills、prompt templates、settings 和 session storage 的共享要求不变；
- 取代 [`pi-native-assistant-ui-runtime-spec.md`](./pi-native-assistant-ui-runtime-spec.md) 中 extension editor 双向同步、`getEditorText()` read-back、working state、hidden-thinking label 和 tools-expanded state 的要求；
- 取代 [`new-session-draft-spec.md`](./new-session-draft-spec.md) 中 draft 必须发现普通 Pi global/project extension commands 的要求；draft 只发现本规范允许的内建、精选和已批准开发 extension；
- 不取代每个 Pi session 同时只能有一个 live writer 的规则。任何 extension reload 设计都必须先停止旧 thread worker，确认退出后才能打开 replacement worker。

后续实现本规范时，必须同步更新上述旧规范的对应验收项，避免长期保留相互矛盾的测试要求。

## 3. 目标

### 3.1 产品目标

- 保留 Pi extension 带来的 tools、commands、events 和 provider 扩展能力。
- 让 Desktop 团队可以发布少量、经过代码审查的精选 extension。
- 为开发者提供显式、可关闭的本地 extension 调试入口。
- 明确区分产品支持的 extension 与未经认证的开发 extension。
- 避免承担第三方插件市场的持续运营成本。

### 3.2 工程目标

- Pi runtime 继续是 session、queue、agent loop 和 extension event 的唯一语义源。
- Desktop 不模拟 TUI component、theme 或 terminal behavior。
- 未批准的 `~/.pi/agent/extensions` 和项目 `.pi/extensions` 不会意外进入 Desktop。
- draft 中显示的 extension commands 与 live worker 实际加载集合一致。
- extension source、版本和 worker generation 可诊断。
- extension 失败不会在 Electron main 或 renderer 执行任意代码。
- command-context session action 不存在成功 no-op。

## 4. 非目标

v1 不包括：

- 兼容任意现有 Pi extension；
- 在线 extensions catalog 或 packages center；
- 第三方 publisher、审核、签名和认证体系；
- runtime 下载、安装、更新、回滚或撤销 extension；
- 解析 npm registry、GitHub release 或任意远程 URL；
- 在 Desktop 中渲染 Pi TUI component；
- 将 terminal ANSI output 转换成 React UI；
- 支持 Pi theme、header、footer、custom editor 或 shortcuts；
- 对 Developer Mode extension 提供强安全 sandbox；
- 在同一 worker generation 中热替换 extension；
- 为旧 Desktop Host Profile 保留无限期兼容层；
- 预先设计未来插件市场的服务端协议。

## 5. 术语

### 5.1 Pi extension

由 Pi `ResourceLoader` 加载、由 extension runner 执行的扩展单元。它可以注册 tools、commands、providers 和 event handlers。

### 5.2 内建 extension

由 Desktop 源码直接注册的 inline extension。它通常用于 Desktop 自有 provider 或必须与 Desktop runtime 同步演进的能力。

### 5.3 精选 extension

源码或构建产物纳入 Meta Agent monorepo，由 Desktop 团队审查、测试并随 Desktop 一起发布的 extension。它没有独立在线安装生命周期。

### 5.4 Developer Mode extension

用户从本地文件系统显式选择并批准的 extension。Desktop 不保证兼容性、安全性或升级稳定性。

### 5.5 Desktop Host Profile

Desktop 在 Pi `ExtensionUIContext` 和 command context 上真实实现的能力集合。它是版本化的 Desktop 产品契约，不等于完整 Pi TUI 或 RPC mode。

### 5.6 ResolvedExtensionSet

某个 project/thread 在一个 worker generation 中实际加载的精确 extension ID、来源和 entry 列表。

## 6. Extension 来源

### 6.1 内建 inline extensions

内建 extension 使用 Pi `ResourceLoader` 的 `extensionFactories` 注册。

当前 `DesktopBuiltinProviderRegistry` 使用该机制注册 Desktop 自有 provider。该路径必须保留，不应为了关闭用户 extension 而移除 extension runner。

内建 extension 要求：

- 源码属于 Desktop；
- 与 Desktop 使用同一版本；
- 由 sidecar 构建产物导入；
- 必须通过 focused tests 和仓库检查；
- 不经过 Developer Mode；
- 不允许被用户单独删除或替换。

### 6.2 精选 extensions

精选 extension 必须满足：

- 源码或完整构建产物在 monorepo 中；
- dependency 和 lockfile 变更按仓库规则审核；
- 不执行 runtime package install；
- 与 Desktop 同时构建和发布；
- 通过 Desktop Host Profile contract tests；
- 由静态 Desktop registry 分配稳定 ID；
- 只从 packaged app 的只读资源或已知构建输出加载；
- 不从用户可写目录覆盖同 ID extension。

建议静态定义：

```ts
type DesktopExtensionCapability =
  | "events.subscribe"
  | "tools.register"
  | "commands.register"
  | "providers.register"
  | "messages.enqueue"
  | "messages.custom"
  | "session.read"
  | "session.abort"
  | "session.compact"
  | "session.reload"
  | "session.replace"
  | "ui.notify"
  | "ui.dialog"
  | "ui.status"
  | "ui.widget.text"
  | "ui.title"
  | "ui.composer.write"
  | "ui.composer.read"
  | "ui.working"
  | "ui.tui.custom"
  | "ui.tui.theme"
  | "ui.tui.chrome"
  | "ui.tui.editor"
  | "ui.terminal.input";

interface DesktopCuratedExtensionDefinition {
  id: string;
  displayName: string;
  entryPath: string;
  hostProfileVersion: 1;
  capabilities: DesktopExtensionCapability[];
}
```

该 registry 是源码配置，不是在线 catalog。它不需要 publisher、下载 URL、签名、更新状态或远程服务。

### 6.3 Developer Mode extensions

Developer Mode 必须默认关闭。开启流程必须明确说明：

- extension 是普通 Node 代码；
- extension 可以读取 sidecar 可访问的文件和环境变量；
- extension 可以发起网络请求或启动子进程；
- extension 可能破坏当前 thread worker；
- Desktop 不保证 Pi TUI extension 可以正常运行；
- Desktop 不为该 extension 提供自动更新或兼容迁移。

Developer Mode extension 的加载规则：

1. 用户通过原生文件选择器选择精确 entry file；
2. renderer 不直接提交任意路径字符串；
3. main 接收由原生 dialog 产生的已批准路径；
4. main 将批准记录保存为 Desktop 开发者设置；
5. 每个 entry 单独启用或禁用；
6. 不扫描 entry 所在目录中的其他 extension；
7. 路径不存在或变化时明确报错；
8. extension set 在 replacement worker 后生效；
9. UI 始终显示 `Development` 标记。

Developer Mode approval 是用户信任记录，不是 Desktop 认证。

## 7. 受控加载

### 7.1 ResourceLoader 配置

live session 与 draft config 必须使用同一策略：

```ts
resourceLoaderOptions: {
  noExtensions: true,
  additionalExtensionPaths: resolvedExtensionSet.entries.flatMap((entry) =>
    entry.entryPath ? [entry.entryPath] : [],
  ),
  extensionFactories: DesktopBuiltinProviderRegistry.getExtensionFactories(),
  packageManagerOnMissing: async () => "error",
}
```

Pi 当前语义允许 `noExtensions: true` 阻止默认 enabled extension discovery，同时继续加载显式 `additionalExtensionPaths` 和 inline factories。

含义：

- 不加载 Pi settings 中的普通 extension 列表；
- 不自动加载全局或项目 extension 目录；
- 精选和 Developer Mode entry 只能由 Desktop source policy 注入；
- 内建 inline extension 继续加载；
- missing entry 是明确错误，不允许现场安装 dependency 或选择替代文件。

### 7.2 ResolvedExtensionSet

```ts
type DesktopExtensionSource = "builtin" | "curated" | "development";

interface ResolvedExtensionEntry {
  id: string;
  source: DesktopExtensionSource;
  entryPath?: string;
  contentHash?: string;
  hostProfileVersion: 1;
  capabilities: DesktopExtensionCapability[];
}

interface ResolvedExtensionSet {
  generation: string;
  projectId: string;
  entries: ResolvedExtensionEntry[];
  resolvedAt: number;
}
```

约束：

- `builtin` entry 可以通过 inline factory 注册，因此不要求暴露路径；
- `curated` entry path 必须位于 packaged/bundled resource root；
- `development` entry path 必须存在于 main 的显式批准记录；
- 同一 extension ID 只能出现一次；
- path-backed entries 在 source policy 中保持稳定顺序，inline factories 使用内建 registry 的稳定顺序；
- Pi `ResourceLoader` 先加载所有 path-backed entries，再追加 inline factories，因此不定义跨这两组的任意交错优先级；
- main 生成不可预测的 generation；
- renderer 不能构造或修改 resolved set；
- source policy 为 path-backed entry 计算内容哈希，sidecar 启动时重新校验 source、path 与哈希，防止 resolve/load 之间的内容变化复用旧 generation；
- resolved set 可以进入 diagnostics，但不得进入 LLM context。

### 7.3 Draft/live 一致性

new-session draft 中显示的 commands、models 和 readiness 必须基于与 live worker 相同的 resolved set。

当前 draft config 由 metadata worker 调用 `createAgentSessionServices()`，因此 extension factories 和 path-backed extensions 会在 metadata worker 中执行。v1 接受这一现实边界，但要求：

- metadata worker 与 live thread worker 使用同一 source policy 和 resolved set；
- metadata worker load failure 返回结构化 diagnostics，并由 registry 重启该 metadata worker；
- Developer Mode extension 可能影响全部 draft metadata 请求，UI 必须明确提示这一风险；
- extension 代码仍不得进入 Electron main、preload 或 renderer；
- 如果后续需要将 Developer Mode draft failure 隔离到单次请求，必须使用 disposable draft worker，而不是在 main 中加载 extension。

如果 extension settings 在 draft 打开后变化：

- create request 携带 draft extension-set generation；
- main 创建 worker 前比较 generation；
- generation 过期时返回 typed stale-draft error；
- renderer 重新获取 draft config；
- 不得静默使用与用户预览不同的 extension set。

对应 wire contract 必须显式扩展，不能只作为进程内隐含状态：

```ts
interface DraftExtensionContext {
  extensionSetGeneration: string;
  diagnostics: Array<{
    extensionId: string;
    source: DesktopExtensionSource;
    code: string;
    message: string;
  }>;
}

interface DraftSessionConfig {
  // Existing fields remain unchanged.
  extensions: DraftExtensionContext;
}

interface SessionCreateInput {
  // Existing fields remain unchanged.
  extensionSetGeneration: string;
}

interface StaleDraftExtensionSetError {
  code: "STALE_DRAFT_EXTENSION_SET";
  requestedGeneration: string;
  currentGeneration: string;
}
```

metadata worker 将 load diagnostics 放入 draft response。metadata worker 进程退出或 request transport 失败时，由 main sidecar registry 按既有 worker restart 责任恢复；业务级 extension load error 返回 diagnostics，不通过 crash 触发重试。

## 8. Desktop Host Profile v1

### 8.1 Runtime 能力

| Capability | Pi surface | v1 |
|---|---|---|
| `events.subscribe` | `pi.on(...)` | 支持 |
| `tools.register` | `pi.registerTool(...)` | 支持 |
| `commands.register` | `pi.registerCommand(...)` | 支持 |
| `providers.register` | `pi.registerProvider(...)` | 仅内建/精选 extension |
| `messages.enqueue` | `pi.sendUserMessage(...)` | 支持，遵循 Pi queue 语义 |
| `messages.custom` | custom message/session entry API | 支持 |
| `session.read` | public session/model/context getters | 支持 |
| `session.abort` | public abort API | 支持 |
| `session.compact` | public compact API | 条件支持，必须有 characterization |
| `session.reload` | `ctx.reload()` | v1 不支持 |
| `session.replace` | new/fork/switch/navigate | v1 不支持 |

`providers.register` 会影响 model registry 和凭据行为，只对内建/精选 extension 做产品支持和回归测试。该限制不是 v1 的运行时安全边界：当前 Pi runner 的共享 registration callback 不能可靠归因所有动态 provider registration，Developer Mode 代码仍可能调用 Pi public API。其失败或副作用属于开发模式风险。若未来要求硬性禁止，必须先提供 extension-scoped registration context。

### 8.2 UI 能力

| Capability | Pi UI surface | v1 |
|---|---|---|
| `ui.notify` | `notify` | 支持，进入 timeline notification |
| `ui.dialog` | `select/confirm/input/editor` | 支持，使用 HostRequest |
| `ui.status` | `setStatus` | 支持 |
| `ui.widget.text` | string-array widget | 支持 |
| `ui.title` | `setTitle` | 支持 |
| `ui.composer.write` | `setEditorText/pasteToEditor` | 支持单向写入 |
| `ui.composer.read` | `getEditorText` | v1 不支持 |
| `ui.working` | working message/visibility/indicator | v1 不支持 |
| `ui.tui.custom` | `custom()` | 不支持 |
| `ui.tui.theme` | theme methods | 不支持 |
| `ui.tui.chrome` | header/footer/tools expanded | 不支持 |
| `ui.tui.editor` | custom editor/autocomplete | 不支持 |
| `ui.terminal.input` | terminal input/shortcuts | 不支持 |

`setWidget` v1 只接受字符串数组。component factory、TUI instance 和 render callback 必须拒绝。

`ui.composer.write` 使用 revision-based 单向命令。Desktop 不为 extension 建立逐键 editor mirror，因此不支持同步 `getEditorText()`。

### 8.3 不支持能力的行为

Desktop 内建和精选 extension 调用不支持能力时必须得到稳定错误：

```ts
interface DesktopExtensionCompatibilityError {
  code:
    | "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE"
    | "DESKTOP_EXTENSION_HOST_DISPOSED";
  capability: string;
  message: string;
}
```

不得：

- 返回成功但不执行 session action；
- 为 TUI-only API 跨进程保存无消费者状态；
- 返回伪造 theme/component；
- 吞掉 component widget 并假装成功。

Developer Mode extension 同样使用该 Host Profile。其 UI API 不因“开发模式”而扩大。

## 9. DesktopExtensionHost

当前 `HostUi` 应收敛并重命名为 `DesktopExtensionHost`。职责仅包括：

- 维护未完成的声明式 dialog requests；
- 发布 extension notifications；
- 维护 status、text widgets、title 和 composer write commands；
- 拒绝不支持的 UI surface；
- 在 session dispose 时取消 pending requests；
- 不保存 TUI 状态；
- 不实现 theme 或 component renderer。

建议最小控制状态：

```ts
interface DesktopExtensionHostState {
  statuses: Record<string, string>;
  windowTitle?: string;
  composerCommand?: {
    hostId: string;
    revision: number;
    mode: "replace" | "append";
    text: string;
  };
  widgets: Array<{
    key: string;
    lines: string[];
    placement: "aboveEditor" | "belowEditor";
  }>;
}
```

应从当前 contracts 删除：

- `workingMessage`；
- `workingVisible`；
- `hiddenThinkingLabel`；
- `toolsExpanded`；
- `HostRequest.type === "notify"` 的不可达分支；
- 为 extension editor read-back 维护的逐键同步状态。

notification 属于 timeline，不同时建模为 pending HostRequest。

### 9.1 共享 UI context 限制

当前 Pi extension runner 给所有 extensions 暴露同一个 `ExtensionUIContext`。Host 调用不携带 extension identity，并且多个 extension handlers 可以异步并发。

因此 v1：

- 所有 extension 共享同一个 Host Profile；
- `capabilities` 用于静态 registry、代码审查、测试和 UI disclosure；
- runtime 可以拒绝全局不支持的方法；
- runtime 不宣称能够按调用者执行强 capability isolation；
- 不使用可变全局 `currentExtensionId` 推断异步调用来源。

如果未来需要逐 extension capability enforcement，必须先让 Pi runner 提供 extension-scoped context，或将每个 extension 放入独立进程。

### 9.2 `mode`

在 Pi 没有正式 Desktop mode 时，`bindExtensions()` 可以继续使用 `mode: "rpc"`，但：

- Desktop 只对本规范列出的能力负责；
- 精选 extension 必须以 Desktop Host Profile 为测试目标；
- 普通 Pi RPC extension 不会自动成为 Desktop 精选 extension；
- Desktop 私有能力不能仅通过 `ctx.mode === "rpc"` 暗示存在。

如果后续 Pi public API 提供 host capability negotiation，应迁移到该公共机制，不增加长期隐式分支。

## 10. Command Context

Desktop 必须显式传入 `commandContextActions`。每个 action 只能有两种状态：

1. 真实实现并有集成测试；
2. 抛出稳定的 capability unavailable error。

不得依赖 Pi runner 的成功 no-op fallback。

v1 建议：

| Action | v1 |
|---|---|
| `waitForIdle` | 真实实现 |
| `reload` | v1 关闭并明确失败 |
| `newSession` | 默认关闭 |
| `fork` | 默认关闭 |
| `navigateTree` | 默认关闭 |
| `switchSession` | 默认关闭 |

session-changing action 会影响 `ThreadWorkerRegistry`、session route cache、attachment lease 和 renderer generation，不能作为 sidecar 内部普通方法补齐。

`ctx.reload()` 返回的 Promise 原本需要在调用它的 worker 中完成，但 extension-set replacement 必须终止该 worker。v1 不定义无法可靠返回结果的自终止事务，因此 `ctx.reload()` 保持 unavailable。第 11.2 节的 extension-set apply 是由 Desktop 设置命令发起的独立流程，不是 `ctx.reload()` 的实现。

## 11. Worker 生命周期

### 11.1 启动

thread worker startup payload 增加 resolved extension set 或其安全引用。

启动顺序：

1. 校验 worker identity 和 protocol version；
2. 校验 resolved extension set；
3. 创建 ResourceLoader；
4. 加载内建、精选和已批准开发 extension；
5. 构建 `AgentSession`；
6. 绑定 `DesktopExtensionHost`；
7. 绑定真实 command-context actions；
8. emit session start；
9. 发布 bootstrap。

extension 加载失败必须进入结构化 diagnostics。精选 extension 的语法错误、entry 缺失或 registration conflict 是 Desktop release defect，不能静默降级成空 extension 集合。

### 11.2 Extension set 变更

本节描述 Desktop 设置层的 `apply extension set` 操作，不实现 extension `ctx.reload()`。

extension set 在 worker generation 内不可变。启用、禁用或修改 Developer Mode entry 后，默认在下一次启动该 session 时生效。用户显式要求立即应用时使用有短暂停机的单写者 reload：

1. main 计算并保存新 resolved set，同时保留旧 set 供失败回滚；
2. 当前 worker 停止接受新 command；
3. 等待当前 run idle，或在用户明确确认后 abort；
4. renderer 保留最后一个有效 snapshot 并进入 reconnecting；
5. main 停止旧 worker，并确认进程已经退出、session writer 已释放；
6. main 启动使用新 resolved set 的 worker；
7. 新 worker 打开相同 Pi session file，完成 extension load 和 bootstrap；
8. registry 按 generation 接受新 worker，renderer transport 执行 resync；
9. 如果新 worker 启动失败，main 使用旧 resolved set 启动恢复 worker 并报告失败。

任何时刻只允许一个 worker 打开该 Pi session。该流程不宣称无中断或新旧 worker 并行 ready；generation 用于拒绝 stale message 和协调重连，不用于绕过 single-writer 规则。

### 11.3 Crash

extension 可能导致 thread worker 退出。main 至少记录：

- extension-set generation；
- extension IDs 和 sources；
- worker instance ID；
- startup/runtime phase；
- exit code/signal；
- 最近 extension diagnostics。

v1 不尝试自动判断某个 extension 是唯一 crash 原因。

恢复策略：

- 内建/精选 extension crash 作为 Desktop defect 报告；
- Developer Mode set 连续 startup crash 时停止自动重启；
- 向用户提供“禁用开发扩展并恢复”操作；
- recovery 不修改 Pi session JSONL；
- 不在没有证据时自动删除用户文件。

## 12. Shared Contracts 与 IPC

extension settings 使用独立、最小的 Desktop contracts，不复用 Pi timeline node。

建议设置接口：

```ts
interface DesktopExtensionSettings {
  curatedEnabled: Record<string, boolean>;
  developerMode: boolean;
  developmentEntries: Array<{
    id: string;
    entryPath: string;
    enabled: boolean;
  }>;
  revision: number;
}
```

安全约束：

- renderer 不通过普通 IPC 输入框提交任意 extension path；
- 添加 development entry 必须走 main 发起的原生 file dialog；
- preload API 返回 opaque entry ID 和安全 display path；
- sidecar 只接收 main 解析后的 resolved set；
- settings mutation 使用 request ID 和 revision/CAS；
- extension settings 不进入 `SessionControlState` 全量快照；
- session control 只携带当前 extension-set generation、reload-required 和必要 diagnostics。

Host requests 保留独立的 request/response 路径，只支持：

- `confirm`；
- `select`；
- `input`；
- `editor`。

`notify` 直接进入 timeline notification，不进入 HostRequest。

## 13. Extension 管理 UI

Desktop 只需要一个设置页，不建设 packages center。

设置页至少包含：

- 内建 extension 列表，只读；
- 精选 extension 开关；
- Developer Mode 总开关；
- 已批准 development entries；
- 添加本地 entry；
- 移除批准记录；
- reload-required 状态；
- extension load diagnostics。

UI 必须：

- 清晰区分 `Built-in`、`Curated` 和 `Development`；
- 对 Developer Mode 展示 Node 权限风险；
- 不使用“认证市场”“安全沙箱”等描述；
- 不提供远程搜索、下载或更新按钮；
- 不允许覆盖内建/精选 extension 的 entry；
- 只有 replacement worker 成功后才显示当前 thread 已应用新配置。

## 14. 安全模型

### 14.1 信任边界

- renderer 是不可信输入源；
- 内建和精选 extension 是 Desktop 发布物的一部分；
- Developer Mode extension 是用户显式信任的本地 Node 代码；
- Node sidecar workers 是 extension 执行边界；
- Electron main、preload 和 renderer 不加载 extension 代码；
- Pi session JSONL 不保存可执行 extension 路径。

### 14.2 v1 提供的防护

- 默认禁止自动 extension discovery；
- 精选 extension path 来自只读 packaged resources；
- Developer Mode path 需要逐项批准；
- renderer 不能直接构造 worker entry list；
- live extension crash 被限制在对应 thread worker 故障域，draft discovery crash 被限制在 metadata worker；
- worker replacement 使用 generation/CAS；
- 不在 runtime 执行 package installation lifecycle；
- 不支持 TUI component 跨进程渲染。

### 14.3 v1 不提供的保证

Developer Mode extension 可能：

- 读取 sidecar 可访问的文件；
- 读取环境变量；
- 发起网络请求；
- 启动子进程；
- 消耗 CPU 或内存；
- 修改 workspace 或用户文件。

这些风险不能通过 Host capability matrix 消除。Developer Mode UI 和文档必须准确披露。

如果未来需要硬隔离，应单独设计 per-extension process、OS sandbox 或受限 runtime，不在当前 shared sidecar 上叠加伪权限系统。

## 15. 版本与兼容性

### 15.1 内建和精选 extension

- 与 Desktop lockstep versioning；
- 与当前 pinned Pi version 一起测试；
- Host Profile breaking change 必须同步修改 extension；
- 不维护独立 semver compatibility matrix；
- 不为旧 Desktop 版本在线分发新 extension。

### 15.2 Developer Mode extension

- 只记录 target Host Profile version；
- Desktop 升级后可以标记为“需要重新确认”；
- load error 必须可见；
- Desktop 不自动迁移源码或 dependency；
- Pi upgrade 不保证继续兼容。

### 15.3 Pi 升级

Desktop 升级 Pi 时必须：

1. 运行 Pi public compatibility characterization；
2. 运行 Host Profile contract tests；
3. 运行全部内建和精选 extension tests；
4. 检查 ResourceLoader controlled-loading 行为；
5. 检查 command-context actions；
6. 不通过宽泛 runtime duck typing 维持多个未知 Pi 行为分支。

## 16. Observability

extension diagnostics 至少包含：

- extension ID；
- source：builtin/curated/development；
- extension-set generation；
- project/thread ID；
- worker instance ID；
- phase：resolve/load/register/start/runtime/dispose；
- stable error code。

Developer Mode entry 的绝对路径只进入本地 diagnostics，不发送到 renderer telemetry。renderer 只显示用户可理解的安全 display path。

不得记录 API key、完整环境变量或未过滤 extension output。

## 17. 迁移计划

### Phase 0：锁定当前行为

- 增加真实 Pi/faux-provider characterization tests；
- 覆盖 tools、commands、events、queue、custom messages、abort 和 compaction，并锁定 `ctx.reload()` unavailable 行为；
- 盘点当前 Host UI 的生产消费者；
- 记录当前 user/project extension 自动发现行为。

完成条件：能够证明关闭默认 discovery 不会误伤内建 provider、skills 或 prompt templates。

### Phase 1：受控来源

- 增加静态 curated extension registry；
- 为 live 和 draft services 设置 `noExtensions: true`；
- 从统一 resolver 注入 `additionalExtensionPaths`；
- 保留 `extensionFactories`；
- 引入 `ResolvedExtensionSet` 和 generation；
- 阻止 renderer/sidecar 自行选择 extension path。

完成条件：未批准的全局/项目 Pi extension 不会加载，内建与精选 extension 正常工作。

### Phase 2：Host Profile 收敛

- 将 `HostUi` 改为 `DesktopExtensionHost`；
- 删除 working、hidden-thinking、tools-expanded 等 TUI 状态；
- 删除不可达 notification HostRequest；
- 删除 editor read-back 逐键同步；
- 保留 dialogs、notify、status、text widget、title 和 composer write；
- command-context action 使用真实实现或明确失败。

完成条件：shared contracts 不含无生产消费者的 TUI compatibility state，且不存在成功 no-op session action。

### Phase 3：Developer Mode

- 增加显式总开关；
- 增加 main-owned native file selection；
- 增加 approval records；
- 增加 replacement worker apply flow；
- 增加风险 disclosure 和 recovery；
- 不增加在线下载或 package install。

完成条件：用户可以显式加载本地开发 extension，并可以在 crash 后禁用全部开发 extension 恢复 session。

## 18. 测试要求

### 18.1 Source policy 单测

必须覆盖：

- builtin/curated/development 合并；
- duplicate ID；
- path-backed 与 inline factories 的分组稳定顺序；
- curated path root 校验；
- Developer Mode 总开关；
- approved path records；
- missing entry；
- settings revision/CAS；
- stale draft generation。

### 18.2 ResourceLoader 集成测试

使用真实 Pi services 和 faux provider，证明：

- `noExtensions: true` 禁止默认 global/project discovery；
- approved additional path 正常加载；
- inline Desktop provider 仍注册；
- skills 和 prompt templates 不受影响；
- draft/live 使用相同 resolved set；
- extension load error 保留 source identity。

### 18.3 Host contract 测试

每个支持能力必须有成功路径测试。只有阻塞式 dialogs/requests 需要覆盖取消、timeout 和 dispose；status、title、widget、notification 和 registration 等同步能力应覆盖更新、清理、冲突和 lifecycle 行为。

每个不支持能力必须验证稳定失败，特别是：

- TUI custom component；
- theme/header/footer/editor component；
- `getEditorText`；
- working/tools-expanded 状态；
- session replacement actions。

### 18.4 Worker 生命周期测试

必须覆盖：

- resolved set startup validation；
- old worker 退出前不得启动 replacement worker；
- reload 期间拒绝新 command 并等待 idle/显式 abort；
- 新 worker 启动失败后使用旧 extension set 恢复；
- generation stale-message rejection；
- renderer reconnect/resync；
- curated extension startup error；
- Developer Mode extension crash；
- repeated crash recovery；
- 禁用 development extensions 后恢复。

### 18.5 设置 UI 测试

必须覆盖：

- source 标签；
- curated enable/disable；
- Developer Mode warning；
- native file approval；
- remove approval；
- reload-required；
- replacement failure 不错误显示已应用。

## 19. 验收标准

v1 完成必须同时满足：

1. Desktop 默认不加载任何普通 Pi user/project extension。
2. Desktop 内建 inline provider 继续工作。
3. 精选 extension 只来自 Desktop 静态 registry 和 bundled resources。
4. Developer Mode 默认关闭，entry 必须逐项批准。
5. renderer 不能直接传入 worker extension paths。
6. draft 与 live worker 使用同一 resolved extension set。
7. 同一 worker generation 的 extension set 不可变。
8. Host Profile 有明确 capability matrix 和 contract tests。
9. Desktop 不渲染或模拟 Pi TUI component。
10. shared contracts 不包含无消费者的 TUI compatibility state。
11. session-changing extension action 不会返回成功 no-op。
12. Developer Mode 不被描述为安全 sandbox。
13. extension crash 不在 Electron main 或 renderer 执行插件代码。
14. Pi 升级有 characterization gate。
15. focused tests 和仓库 `npm run check` 通过。

## 20. 未来演进

只有在真实需求证明以下成本值得承担时，才另立 spec 讨论扩展分发中心：

- 第三方 publisher；
- artifact signing；
- 在线 catalog；
- install/update/revoke；
- compatibility matrix；
- abuse 和供应链治理。

未来分发层可以生成本规范定义的受控 entry set，但不能改变以下边界：

- Pi 负责 extension execution；
- Desktop source policy 决定加载来源；
- Desktop Host Profile 定义有限 UI 能力；
- extension 只在 sidecar 执行；
- 未经明确批准的代码不进入 runtime。
