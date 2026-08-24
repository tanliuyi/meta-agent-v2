# Meta Agent Desktop 受控扩展规范

> 状态：Draft（联网市场相关条款已部分废止）
>
> 适用范围：`packages/desktop` 与 Pi extension runtime 集成
>
> 目标版本：Desktop Extension Host Profile v1
>
> 部分废止说明：[`plugin-marketplace-product-spec.md`](./plugin-marketplace-product-spec.md) 已接受并取代本文中“不建设在线 packages center”、不提供下载/签名/更新/撤销、source 仅限 `builtin/curated/development`、marketplace provider 不受支持，以及不复制预构建依赖/native artifact 的相关条款。Pi runner、受控 entry set、Host Profile、immutable worker generation、single-writer replacement 和 Developer Mode 边界继续有效。当前实现也不再为 path-backed entry 计算或校验内容 hash；generation 由设置 revision、marketplace artifact key、入口路径和配置 revision 决定。

## 1. 摘要

Meta Agent Desktop 保留 Pi extension 机制作为 agent runtime 的扩展执行底座，但不承诺兼容任意 Pi TUI、RPC 或本地 extension。

Desktop 只加载以下来源：

1. Desktop 随应用发布的 bundled extensions；
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
5. Desktop 内建 extension 物化为 packaged local entry，并通过 Pi 公共 CLI `-e` 显式加载。
6. Desktop 精选 extension 使用只读、版本锁定的 bundled entry paths。
7. Developer Mode extension 必须由用户逐项显式批准，不扫描目录自动加载。
8. extension 代码只在 Node sidecar 进程树中执行：live session 使用 thread worker 启动 Pi RPC，draft discovery 使用 metadata worker 按请求启动 disposable Pi RPC；Electron main、preload 和 renderer 不导入 extension 代码。
9. 每个 thread worker generation 使用不可变 extension set。
10. extension set 变化通过 replacement worker 生效，不在运行中的 worker 内热替换代码。
11. Desktop v1 只实现声明式 Host UI，不复刻 Pi TUI。
12. 不支持的 API 必须明确失败或按本规范定义降级，不得返回伪成功。
13. Developer Mode 是信任开关，不是安全 sandbox。
14. extension 配置与 session timeline 分离，不写入 Pi conversation context。
15. 当前不为未来扩展中心预建 catalog、installer、publisher 或 artifact registry。
16. 从旧 Desktop 架构升级时，必须先发现并呈现旧 extension 迁移清单；关闭默认 discovery 不得静默丢弃既有扩展意图。
17. 旧 extension 文件与 Pi settings 保持原位。Desktop 只保存自己的迁移决策，不删除、移动或改写用户的 Pi 资源。

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

由 Desktop 源码构建并随应用发布的 extension。当前外部 Pi RPC 架构要求它物化为 packaged local entry，再通过公共 CLI `-e` 显式加载；它通常用于 Desktop 自有 provider 或必须与 Desktop runtime 同步演进的能力。

### 5.3 精选 extension

源码或构建产物纳入 Meta Agent monorepo，由 Desktop 团队审查、测试并随 Desktop 一起发布的 extension。它没有独立在线安装生命周期。

### 5.4 Developer Mode extension

用户从本地文件系统显式选择并批准的 extension。Desktop 不保证兼容性、安全性或升级稳定性。

### 5.5 Desktop Host Profile

Desktop 在 Pi `ExtensionUIContext` 和 command context 上真实实现的能力集合。它是版本化的 Desktop 产品契约，不等于完整 Pi TUI 或 RPC mode。

### 5.6 ResolvedExtensionSet

某个 project/thread 在一个 worker generation 中实际加载的精确 extension ID、来源和 entry 列表。

## 6. Extension 来源

### 6.1 内建 bundled extensions

内建 extension 由 Desktop 构建流程物化为 packaged local entry，经 main-owned registry 解析后与其他受控来源一起通过 Pi 公共 CLI `-e` 加载。外部 Pi RPC 进程边界不提供进程内 `extensionFactories` 注入；不得为保留旧 SDK 方案而在 Electron main、preload 或 renderer 导入 extension。

内建 extension 要求：

- 源码属于 Desktop；
- 与 Desktop 使用同一版本；
- entry 位于 packaged/bundled resource root；
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

### 6.4 旧架构迁移候选

旧 Desktop 架构曾允许普通 Pi user/project extension 进入运行时。升级后的首次受控启动必须在禁用默认 discovery 前建立迁移清单，但旧来源不是新的长期运行时 source 类型。

迁移发现范围仅限旧架构已经可能加载的来源：

- Pi 全局与项目 settings 中声明的 extension entry；
- `~/.pi/agent/extensions` 与受信任项目 `.pi/extensions` 中可自动发现的 entry；
- Pi settings 中 package manifest 声明并已安装到本地的 extension entry；
- Desktop 维护的已知旧 ID 到 curated/marketplace replacement 的静态映射。

发现阶段只能读取 settings、目录项、`package.json` 和 Pi manifest，不得在 Electron main、preload 或 renderer 中导入或执行 extension 代码，不得联网、安装 package、刷新 git checkout 或运行 lifecycle script。package source 必须先解析为当前已经存在的本地 entry；`npm:`、`git:` 等 source string 不得原样传给 Pi `-e`。

候选身份由 source kind、canonical source identity 和 manifest-relative entry path 组成。相对路径、symlink、Windows 路径大小写和 Unicode normalization 必须规范化；同一 canonical entry 的多个 settings/directory/package origin 合并展示，不同安装版本或 commit 不得静默合并。inventory 必须保留 scope、原始 origin、package filter、安装版本或 commit、manifest entry 和 canonical local path，防止迁移扩大原有启用集合。

每个候选必须归类为：

```ts
type LegacyExtensionMigrationStatus =
  | "unverified"
  | "ready"
  | "replacement"
  | "conflict"
  | "incompatible"
  | "failed";
```

处理规则：

- `unverified`：仅完成静态发现，等待用户确认是否信任并执行兼容性探测；
- `ready`：只表示当前 pinned Pi 下 RPC 启动和 registration 成功；经用户确认后转为已批准的 `development` entry，不声称 tools/events/Host UI 已完整兼容；
- `replacement`：用户确认后启用对应 curated/marketplace entry，旧 entry 保留但不加载；
- `conflict`：必须展示所有冲突来源并由用户选择，不得依赖 Pi 的加载顺序；
- `incompatible`：保留来源、诊断和迁移状态，不进入 RPC worker；
- `failed`：保留可重试诊断，不删除源文件。

RPC 启动/注册探测只能在 disposable sidecar worker 中执行，使用当前固定 Pi 版本、`--no-extensions` 和单个显式本地 entry。探测必须设置临时空 `PI_CODING_AGENT_DIR`、临时 cwd、`--no-session`、最小环境变量、启动超时、输出上限和确定性进程树清理；不得在用户真实 agentDir/cwd 上触发 Pi migrations。单项通过后必须对最终组合再执行一次启动探测，以发现工具和 flag registration conflict。探测进程具有与 Developer Mode extension 相同的 Node 权限风险，不是安全 sandbox，因此必须在用户确认信任后执行。未经 OS 级文件、网络和子进程隔离时，UI 只能将其描述为“对已信任代码进行 RPC 启动检查”。

迁移状态必须可中断、可恢复且幂等。同一 canonical entry 和 inventory revision 已有终态时不得每次启动重复探测；来源身份或 manifest 变化后必须回到待确认状态。转换为普通 development entry 后遵循 Developer Mode 的显式路径信任语义，不把 migration revision 冒充为持续内容完整性保证。

## 7. 受控加载

### 7.1 Pi RPC launch profile

live session、draft config 和 migration probe 必须经同一个纯 launch-profile builder 生成 Pi 公共 CLI 参数：

```ts
const extensionArgs = [
  "--no-extensions",
  ...resolvedExtensionSet.entries.flatMap((entry) => ["-e", entry.entryPath]),
];
```

`PiRpcClient.launch()` 继续统一添加 `--mode rpc`。draft 和 probe 额外添加 `--no-session`；probe 额外使用隔离的 agentDir/cwd/environment。不得在 Electron main、preload 或 renderer 中导入 extension，也不得依赖 Desktop 无法通过外部 Pi CLI 注入的进程内 `extensionFactories`。

Pi 当前公共 CLI 语义允许 `--no-extensions` 阻止默认 enabled extension discovery，同时继续加载显式 `-e` entry。Pi 自身始终加载的 pinned built-in extensions 属于受信基线，不伪装成 Desktop source entry；每次 Pi 升级必须通过 characterization 锁定其集合和行为。

含义：

- 不加载 Pi settings 中的普通 extension 列表；
- 不自动加载全局或项目 extension 目录；
- Desktop builtin、精选、marketplace 和 Developer Mode entry 必须先物化为 main 已批准的本地 entry，再由 source policy 显式注入；
- missing entry 是明确错误，不允许启动路径现场安装 dependency、刷新 source 或选择替代文件；
- draft/live 对同一 generation 生成完全相同且稳定排序的 `-e` 参数。

### 7.2 ResolvedExtensionSet

```ts
type DesktopExtensionSource =
  | "builtin"
  | "curated"
  | "marketplace"
  | "development";

interface ResolvedExtensionEntry {
  id: string;
  source: DesktopExtensionSource;
  entryPath: string;
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

- 所有 Desktop-controlled entry 必须物化为可传给 Pi 公共 CLI `-e` 的本地路径；
- `curated` entry path 必须位于 packaged/bundled resource root；
- `development` entry path 必须存在于 main 的显式批准记录；
- 同一 extension ID 只能出现一次；
- path-backed entries 在 source policy 中保持稳定顺序；
- main 生成不可预测的 generation；
- renderer 不能构造或修改 resolved set；
- path-backed entry 的 generation 按本文开头的现行简化决策生成；sidecar 启动时重新校验 source 和 canonical path。Developer Mode 是路径信任，不宣称提供内容完整性；marketplace artifact identity 由 marketplace 规范定义；
- resolved set 可以进入 diagnostics，但不得进入 LLM context。

### 7.3 Draft/live 一致性

new-session draft 中显示的 commands、models 和 readiness 必须基于与 live worker 相同的 resolved set。

当前 draft config 由 metadata worker 按请求启动独立 Pi RPC 子进程，因此每次 draft 请求必须携带项目对应的 resolved set，并与 live worker 共用同一个 launch-profile builder。v1 要求：

- metadata worker 与 live thread worker 使用同一 source policy 和 resolved set；
- 单次 draft Pi 子进程 load failure 返回结构化 diagnostics；
- Developer Mode extension 可能影响对应项目的 draft metadata 请求，UI 必须明确提示这一风险；
- extension 代码仍不得进入 Electron main、preload 或 renderer；
- draft 请求必须使用 disposable Pi 子进程，不能在长期 metadata worker 或 main 中加载 extension。

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
| `configuration.read` | `pi.getConfig()` | 支持；仅返回当前 extension 的宿主配置快照 |
| `tools.register` | `pi.registerTool(...)` | 支持 |
| `commands.register` | `pi.registerCommand(...)` | 支持 |
| `providers.register` | `pi.registerProvider(...)` | 支持（内建/精选/市场/开发） |
| `messages.enqueue` | `pi.sendUserMessage(...)` | 支持，遵循 Pi queue 语义 |
| `messages.custom` | custom message/session entry API | 支持 |
| `session.read` | public session/model/context getters | 支持 |
| `session.abort` | public abort API | 支持 |
| `session.compact` | public compact API | 条件支持，必须有 characterization |
| `session.reload` | `ctx.reload()` | v1 不支持 |
| `session.replace` | new/fork/switch/navigate | v1 不支持 |

`providers.register` 会影响 model registry 和凭据行为，对全部来源（内建、精选、市场、开发）提供产品支持与 contract tests。该支持不是 v1 的运行时安全边界：当前 Pi runner 的共享 registration callback 不能可靠归因所有动态 provider registration。provider credential、OAuth 和 model side effects 遵循 Pi public API 与现有 Desktop provider/auth contracts。若未来要求逐来源禁止，必须先提供 extension-scoped registration context。

### 8.2 UI 能力

| Capability | Pi UI surface | v1 |
|---|---|---|
| `ui.notify` | `notify` | 支持，进入 timeline notification |
| `ui.dialog` | `select/confirm/input/editor` | 支持，使用 HostRequest |
| `ui.status` | `setStatus` | 支持 |
| `ui.widget.text` | string-array widget | 支持 |
| `ui.title` | `setTitle` | 支持 |
| `ui.composer.write` | `setEditorText/pasteToEditor` | 支持单向写入 |
| `ui.composer.read` | `getEditorText` | 降级：警告并返回 undefined |
| `ui.working` | working message/visibility | 支持 message 与 visible；indicator 帧与 hidden-thinking label 降级 |
| `ui.tui.custom` | `custom()` | 不支持 |
| `ui.tui.theme` | theme methods | 不支持 |
| `ui.tui.chrome` | header/footer/tools expanded | 不支持 |
| `ui.tui.editor` | custom editor/autocomplete | 不支持 |
| `ui.terminal.input` | terminal input/shortcuts | 不支持 |

`setWidget` v1 只接受字符串数组。component factory、TUI instance 和 render callback 必须拒绝。

`ui.composer.write` 使用 revision-based 单向命令。Desktop 不为 extension 建立逐键 editor mirror，因此不支持同步 `getEditorText()`。

### 8.3 不支持能力的行为

不支持能力分为两类，两类都作用于全部来源（共享 runner 无法按调用者归因）：

1. **display/read 类表面降级为“警告 + 定义 no-op”**：调用不抛错，产生一条 `DESKTOP_EXTENSION_CAPABILITY_DEGRADED` runtime diagnostic（去重后进入 extension diagnostics），并按定义返回无害值。覆盖 `ui.tui.custom`、`ui.tui.theme`、`ui.tui.chrome`、`ui.tui.editor`、`ui.terminal.input`、`ui.working` 的 indicator/hidden-label 部分、`ui.composer.read`（返回 undefined）以及 component widget（忽略并保留原状态）。
2. **session-changing 与 disposed-host 保持稳定错误**：

```ts
interface DesktopExtensionCompatibilityError {
  code:
    | "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE"
    | "DESKTOP_EXTENSION_HOST_DISPOSED";
  capability: string;
  message: string;
}
```

覆盖 `session.reload`、`session.replace`（newSession/fork/navigateTree/switchSession）以及 disposed host 上的任何调用。

不得：

- 对 session-changing action 返回成功但不执行；
- 为 TUI-only API 跨进程保存无消费者状态；
- 返回伪造 theme/component；
- 吞掉 component widget 并假装成功（component widget 必须产生诊断）。

Developer Mode extension 同样使用该 Host Profile。其 UI API 不因“开发模式”而扩大。

### 8.4 声明式插件配置

Marketplace artifact 可以在 `market-manifest.json` 中声明版本化的 `configuration` schema。Desktop 只接受受限字段联合，不接受任意 renderer 组件或可执行 JSON Schema 扩展。v1 支持 `text`、`textarea`、`path`、`number`、`boolean`、`select` 和 `secret` 字段，并限制字段数、文本长度、选项数、默认值及数值范围。

配置由 Desktop main 进程验证并按插件 ID 独立持久化。普通值写入 owner-only 文件；`secret` 值使用 Electron `safeStorage` 加密，renderer snapshot 只包含是否已配置，不包含明文。保存使用 request ID、revision/CAS、文件锁和原子替换。

main 在解析 `ResolvedExtensionSet` 时读取并验证配置，将配置 revision 纳入 generation fingerprint，并把已解密的运行时快照发送到对应 worker。Pi loader 按 entry path 绑定配置，插件 factory 通过 `pi.getConfig()` 读取冻结快照。配置不写入 session timeline、LLM context、diagnostics 或进程环境。配置变化对新 worker 生效；运行中的 worker 继续使用不可变旧快照，直到执行现有 replacement/apply 流程。

## 9. DesktopExtensionHost

当前 `HostUi` 应收敛并重命名为 `DesktopExtensionHost`。职责仅包括：

- 维护未完成的声明式 dialog requests；
- 发布 extension notifications；
- 维护 status、text widgets、title、composer write commands 和 working message/visibility；
- 不支持的 display/read surface 降级为警告 + 定义 no-op（§8.3）；
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
  working?: {
    message?: string;
    visible?: boolean;
  };
}
```

应从当前 contracts 删除：

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
3. 构造唯一 Pi RPC launch profile；
4. 通过公共 CLI `--no-extensions` 和重复 `-e` 加载内建、精选、marketplace 和已批准开发 extension；
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
  legacyMigration: {
    version: 1;
    state: "pending" | "review-required" | "completed";
    candidates: Array<{
      id: string;
      sourceKind: "settings-entry" | "auto-directory" | "package-entry";
      canonicalSourceIdentity: string;
      canonicalEntryPath: string;
      inventoryRevision: string;
      origins: Array<{
        scope: "global" | "project";
        displaySource: string;
      }>;
      package?: {
        originalSource: string;
        installedVersionOrCommit: string;
        manifestEntry: string;
        extensionsFilter: string[];
      };
      status: LegacyExtensionMigrationStatus;
      approvedForProbe: boolean;
      probePiVersion?: string;
      selectedReplacementId?: string;
      diagnosticCode?: string;
    }>;
  };
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
- 旧架构迁移入口、候选状态和未解决冲突数量；
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
- live extension crash 被限制在对应 thread worker 故障域，draft extension crash 被限制在该请求启动的 disposable Pi 子进程；
- worker replacement 使用 generation/CAS；
- 不在 runtime 执行 package installation lifecycle；
- 不支持 TUI component 跨进程渲染；
- display/read 能力缺失以“警告 + 定义 no-op”降级，session-changing 能力保持硬失败，不存在静默成功。

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
4. 检查公共 CLI `--no-extensions` + explicit `-e` controlled-loading 行为；
5. 检查 command-context actions；
6. 不通过宽泛 runtime duck typing 维持多个未知 Pi 行为分支。

### 15.4 旧 Desktop 架构升级

`--no-extensions` 是迁移完成后的运行时安全边界，不是迁移机制。检测到旧架构 extension 候选时，Desktop 必须满足：

1. 主界面可以启动，候选 extension 不得在 Electron main 或 renderer 执行；
2. 在创建依赖扩展能力的 draft/live worker 前展示迁移审查；
3. 用户可以迁移、选择 replacement、保持禁用或暂缓处理；
4. 暂缓处理不会丢失候选记录，并允许稍后从设置页恢复；
5. 已知 replacement 不得与旧 entry 同时自动启用；
6. 不兼容项必须展示稳定错误码和安全 display path；
7. 不自动改写 extension 源码、安装依赖或建立旧 Host API adapter；
8. 不修改 Pi TUI 的全局或项目 enabled state；
9. 迁移成功后，draft 与 live 通过同一 `ResolvedExtensionSet` 显式加载结果。

旧 entry 转成 development entry 时视为新的 Node 代码信任批准，不能沿用旧版本中的隐式自动发现作为永久授权。产品可以批量展示候选，但每个最终启用的本地 entry 必须有明确选择记录。

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

### Phase 0.5：旧扩展迁移基础

- 增加只读 legacy discovery，不执行候选代码；
- 增加 migration settings、revision/CAS 和幂等状态机；
- 增加已知 replacement registry；
- 增加 disposable compatibility probe；
- 在首次受控启动与设置页提供迁移审查；
- 保留旧文件和 Pi settings，不建立旧 Host API compatibility layer。

完成条件：旧架构用户升级后可以看到全部可发现候选及其处理结果；没有候选会因为 Phase 1 关闭 discovery 而静默消失。

### Phase 1：受控来源

- 增加静态 curated extension registry；
- 增加唯一 Pi RPC launch-profile builder；
- live、draft 和 probe 固定传入 `--no-extensions`；
- 从统一 resolver 生成稳定排序、重复的 `-e <local-entry>`；
- 将 Pi pinned built-ins 纳入升级 characterization baseline；
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

### 18.1 Source policy 与迁移单测

必须覆盖：

- legacy global/project/settings/package discovery；
- discovery 不导入或执行 extension，首次发现状态为 `unverified`；
- canonical identity 合并 settings/directory/package aliases，同时保留全部 origins；
- package filter、多 entry、安装版本/commit 和 manifest entry 不丢失；
- 扫描不联网、不安装、不刷新 git source、不运行 lifecycle；
- migration 状态机幂等与中断恢复；
- inventory revision 变化后重新确认；
- known replacement 不与旧 entry 同时启用；
- conflict 必须显式选择；
- incompatible/failed 候选保留且不进入 resolved set；
- 迁移不修改 Pi settings 或旧文件；
- builtin/curated/development/marketplace entry 合并；
- duplicate ID；
- path-backed entries 稳定排序；
- curated path root 校验；
- Developer Mode 总开关；
- approved path records；
- missing entry；
- settings revision/CAS；
- stale draft generation。

### 18.2 Pi RPC launch-profile 集成测试

使用 fake Pi argv fixture、真实 pinned Pi 和 faux provider，证明：

- `--no-extensions` 禁止默认 global/project discovery；
- approved local entry 通过独立 `-e` argv 正常加载，含空格路径不被拆分；
- 不把 `npm:`、`git:` 或未解析 package source 传给 `-e`；
- Pi pinned built-ins 与 skills/prompt templates 的 characterization 不受影响；
- draft/live 使用相同 ordered entries 和 generation；
- probe 使用临时空 agentDir/cwd、最小环境和 `--no-session`；
- 带 sentinel 副作用的候选证明静态 inventory 不执行代码；
- probe 前后真实 Pi settings、extensions 与 package 目录保持不变；
- extension load error 保留 source identity；
- RPC 启动/registration 成功不会被错误标记为完整 Host Profile 兼容。

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
2. 从旧架构升级时，关闭默认 discovery 前已生成可恢复的迁移清单，且不存在静默丢弃的候选。
3. 旧 extension 文件与 Pi settings 不被 Desktop 删除、移动或改写。
4. 候选经明确批准后可以执行隔离的 RPC 启动/注册检查；ready、replacement、conflict 和 incompatible 状态均可见且可处理，且 UI 不把检查结果声称为完整兼容认证。
5. 静态 inventory 不执行 extension、不联网、不安装 package，probe 不在真实 agentDir/cwd 触发 Pi migrations。
6. 所有 Desktop-controlled extension 只通过 main 解析的本地 entry 和公共 CLI `-e` 加载；Pi pinned built-ins 有 characterization gate。
7. 精选 extension 只来自 Desktop 静态 registry 和 bundled resources。
8. Developer Mode 默认关闭，entry 必须逐项批准。
9. renderer 不能直接传入 worker extension paths。
10. draft 与 live worker 使用同一 resolved extension set、稳定 argv 和 generation。
11. 同一 worker generation 的 extension set 不可变。
12. Host Profile 有明确 capability matrix 和 contract tests。
13. Desktop 不渲染或模拟 Pi TUI component。
14. shared contracts 不包含无消费者的 TUI compatibility state。
15. session-changing extension action 不会返回成功 no-op。
16. Developer Mode 不被描述为安全 sandbox。
17. extension crash 不在 Electron main 或 renderer 执行插件代码。
18. Pi 升级有 characterization gate。
19. focused tests 和仓库 `npm run check` 通过。

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
