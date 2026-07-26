# Meta Agent Desktop 联网插件市场产品规范

状态：Accepted
最后更新：2026-07-26
适用范围：`packages/desktop`、Desktop 市场服务与标准 Pi Extension 集成

## 1. 摘要

Meta Agent Desktop 新增联网插件市场，为用户提供插件发现、详情查看、安装、启用、禁用、更新、卸载和撤销提示。

市场只替换插件的分发与安装渠道，不定义第二套插件运行模型：

- 市场插件仍是标准 Pi Extension；
- 插件继续导出 Pi `ExtensionAPI` factory；
- 插件继续使用 Pi 的 tools、commands、events、providers 和 session API；
- 插件安装位置继续使用 Pi 的 global/project extension 目录；
- Pi `ResourceLoader`、extension runner、event dispatch 和 tool execution 语义保持不变；
- Desktop 不使用 Pi npm/git package manager，不修改 Pi `settings.json` package entries，也不执行 `npm install`；
- Desktop main 独立负责目录请求、制品下载、签名与哈希校验、安全解包、可恢复安装、更新、卸载和回滚；
- 市场后端不绑定到 Desktop 内置 URL，用户可以在 Settings 配置当前 Marketplace API Base URL。

插件采用全信任模型。安装后的 extension 在普通 Node sidecar 中运行，具有 sidecar 用户权限，可以访问文件、网络、环境变量和子进程，也可以加载预构建 `.node` 模块和平台二进制。Desktop 不把 capability disclosure、publisher 签名或 worker 进程描述为安全 sandbox。

核心定位：

```text
Marketplace
    = 发现、分发、来源证明、完整性和版本治理

Pi Extension
    = 插件代码格式、安装布局和执行语义

Desktop Extension Source Policy
    = 决定 Desktop 允许加载的精确 entry 与 generation

Desktop Host Profile
    = Desktop 对 Pi Extension API 的实际兼容范围
```

## 2. 规范优先级

本规范是 Desktop 联网插件市场的产品 authority，并在市场相关范围内取代 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 的以下旧决策：

- “Desktop 不建设在线 packages center”；
- “不提供第三方扩展的发现、下载、签名、认证、自动更新或撤销服务”；
- `DesktopExtensionSource` 只包含 `builtin/curated/development`；
- extension 设置只包含精选开关和 Developer Mode approval；
- 第 4、13、17、19、20 节中排除或推迟插件市场的要求。

以下既有边界继续有效：

- Pi 负责 extension execution；
- Desktop 默认禁止普通 Pi extension 自动发现；
- Desktop 通过 main-owned `ResolvedExtensionSet` 注入允许加载的 entry；
- extension 代码只在 Node sidecar 中执行，不进入 Electron main、preload 或 renderer；
- live 和 draft 使用相同 source policy；
- worker generation 内 extension set 不可变；
- extension set 变更通过 replacement worker 生效；
- 旧 worker 确认退出前不得启动同一 session 的 replacement writer；
- Desktop Host Profile 不模拟 Pi TUI；
- capability disclosure 不是逐插件 OS 权限隔离。

实施本规范时必须同步修订 `desktop-controlled-extensions-spec.md` 和 `node-sidecar-per-thread-spec.md` 中已被取代的文字，避免长期保留相互冲突的验收要求。

## 3. 产品目标

### 3.1 用户目标

- 用户可以在 Desktop 内搜索和浏览可用插件。
- 用户可以在离开应用或运行终端命令的情况下安装插件。
- 用户可以在安装前查看 publisher、版本、兼容性、能力说明和全信任风险。
- 用户可以选择 global 或当前 trusted project 安装范围。
- 用户可以查看已安装版本、可用更新、启用状态和加载诊断。
- 用户可以安全更新或卸载市场管理的插件，并在启动失败时恢复上一版本。
- 用户离线时仍可管理已安装插件，市场网络失败不影响聊天和已安装插件运行。
- 用户可以在 Desktop Settings 配置、测试和更换当前 Marketplace API Base URL。

### 3.2 生态目标

- 插件作者继续编写标准 Pi Extension，不学习 Desktop 私有运行时 API。
- 插件作者可以发布纯 TypeScript/JavaScript extension，也可以发布带预构建依赖、`.node` 模块和平台二进制的 extension。
- 同一插件版本可以针对不同 sidecar runtime compatibility 发布多个制品。
- 市场能够撤回已知有风险的版本并向已安装用户展示明确状态。
- Desktop 和 Pi CLI 可以共享市场安装后的标准 extension 目录与代码。

### 3.3 工程目标

- 不修改 Pi extension registration、runner、events、tools 或 command semantics。
- 不复用 Pi npm/git package manager 和 package persistence。
- 不在用户机器上执行 package lifecycle、dependency install 或源码编译。
- 下载、安装和更新具备完整性校验、持久事务日志、幂等恢复和故障回滚。
- 市场 endpoint、trust fingerprint 和连接状态由独立 Desktop settings 管理，不编译绑定后端域名。
- Renderer 不接触任意文件路径、下载 URL、签名密钥或可执行插件代码。
- Desktop source policy 仍是 live/draft extension entry 的唯一权威来源。
- 兼容性选择基于实际 sidecar runtime，而不是 Electron runtime。

## 4. 非目标

首期不实现：

- npm registry、Git repository、GitHub Release 或任意 URL 的直接安装；
- 调用 `npm install`、`pnpm`、`bun`、`node-gyp`、CMake 或其他现场构建工具；
- 修改 Pi `settings.json` 中的 `packages` 或 `extensions`；
- 改写 Pi extension loader 或引入第二套 Plugin SDK；
- 在 Desktop renderer 中执行插件代码；
- 对插件提供文件、网络、环境变量或子进程 sandbox；
- 声称 publisher 签名或 capability 列表可以证明插件安全；
- 在同一 worker generation 内热替换 extension；
- 自动修复不兼容、缺依赖或损坏的第三方插件代码；
- 静默删除用户修改过的市场插件目录；
- 首期支持插件付费、订阅、退款、评分、评论或站内社交；
- 首期提供第三方自助审核后台和公开 publisher onboarding；
- 首期允许插件注入任意 React renderer bundle 或修改 Desktop 导航结构。

## 5. 术语

### 5.1 市场插件

通过 Meta Agent Marketplace 发现和安装、由 Desktop installer 管理，但在运行时仍作为标准 Pi Extension 加载的插件。

### 5.2 市场制品

市场用于传输某个插件精确版本与 runtime target 的不可变归档。制品是安装运输容器，不是新的 Pi runtime package 类型。

### 5.3 Runtime target

描述某个制品适用 sidecar 环境的兼容性条件，包括 platform、arch、Node ABI、N-API、libc 和最低 OS baseline。

### 5.4 Managed installation

包含有效 `.meta-agent-market.json` ownership record，并且文件与市场 registry 对应的插件安装目录。

### 5.5 Full-trust disclosure

安装前向用户明确展示插件拥有普通 Node 代码能力的风险说明。它是知情确认，不是权限授权或 sandbox 配置。

### 5.6 撤回

市场因安全、法律、完整性或兼容性原因将某个版本标记为不可继续安装，并向已安装用户发出状态提示。撤回不默认静默删除用户文件。

## 6. 用户与核心场景

### 6.1 普通用户

- 搜索一个能力，例如 Git、数据库、浏览器或子智能体；
- 查看插件详情和风险；
- 全局安装并应用到当前会话；
- 收到更新提示并升级；
- 禁用或卸载不再需要的插件。

### 6.2 项目用户

- 将插件安装到当前 trusted project；
- 让该插件只对项目 Pi 环境可见；
- 在 project 未受信任时得到明确阻止，而不是自动提升信任。

### 6.3 插件开发者

- 使用 Pi 文档和 `ExtensionAPI` 开发 extension；
- 在 Developer Mode 中本地验证；
- 生成包含全部 runtime dependencies 的市场制品；
- 为需要 native code 的版本上传多个 target artifacts；
- 发布后由市场完成签名、目录展示和撤回治理。

### 6.4 故障恢复用户

- 更新后插件导致 worker 启动失败；
- Desktop 自动恢复上一版本和上一 extension set；
- 用户看到具体插件、版本、阶段和恢复结果；
- 用户可以保持旧版本、禁用插件或重试更新。

## 7. 产品信息架构

### 7.1 路由

新增独立一级路由：

```text
/plugins
/plugins/$pluginId
```

插件中心从聊天侧边栏底部进入，不要求 attach Pi session。当前 session identity 仅用于显示“应用到当前会话”和当前 project scope。

现有 `/settings/extensions` 保留为高级扩展管理页，负责：

- 当前 extension set 和 diagnostics；
- Marketplace API Base URL、连接测试、市场 identity 和 signing-key fingerprint；
- Developer Mode；
- 本地 development entry approval；
- 市场插件的高级启用状态和应用状态。

首期只支持一个活动市场 endpoint。未配置 endpoint 时插件中心显示配置入口，已安装插件管理仍可使用。发行构建可以提供可覆盖的初始建议 URL，但业务逻辑、API client、artifact validator 和 trust model 不得依赖固定域名。增加多个并行市场属于后续能力。

插件中心负责发现、详情、安装、更新和卸载。两个页面使用同一个 main-owned snapshot，不建立两个配置源。

### 7.2 插件中心布局

插件中心是高密度工作页面，不使用营销式大卡片瀑布流。

```text
顶部：搜索 / 分类 / 刷新
├─ 左侧：发现、已安装、可更新、分类
├─ 中间：可扫描插件列表
└─ 右侧或详情路由：说明、版本、兼容性、风险和操作
```

列表项至少显示：

- 名称和 publisher；
- 一行简介；
- 最新兼容版本；
- 安装、已安装、更新可用或不兼容状态；
- 是否包含 native code；
- 审核/撤回状态。

详情至少显示：

- 完整说明和 changelog；
- publisher identity；
- 当前版本与其他可用版本；
- Desktop、Pi 和 runtime compatibility；
- Pi/Host capabilities；
- `nativeModules`、`executables` 风险标记；
- 安装范围选择；
- 安装、更新、禁用、启用和卸载命令；
- 当前加载 diagnostics。

### 7.3 安装确认

首次安装和新增高风险内容的更新必须显示确认对话框。固定风险文案必须明确：

> 此插件将在你的账户权限下运行，可以读取和修改文件、访问网络、读取环境变量及执行程序。仅安装你信任的插件。

包含 `.node` 或平台二进制时额外显示：

> 此版本包含原生代码或可执行程序。它们将在插件运行时由普通 Node sidecar 加载或启动。

确认对话框必须显示精确 publisher、版本、scope 和新增 capability/native content。更新没有新增 disclosure 时可以使用普通更新确认；不得因版本升级静默扩大用户已确认的风险范围。

## 8. 市场服务合同

### 8.1 Endpoint 配置与信任引导

Settings 持久化当前活动市场：

```ts
interface MarketplaceEndpointSettings {
  activeMarketplaceId?: string;
  endpoints: Array<{
    marketplaceId: string;
    baseUrl: string;
    trustedKeyId: string;
    trustedKeyFingerprint: string;
    lastRevocationSequence?: number;
    lastRevocationCheckedAt?: number;
    active: boolean;
  }>;
  revision: string;
}
```

约束：

- `baseUrl` 是用户可编辑的绝对 URL，保存前由 main 解析和规范化；credentials、query、fragment、非 HTTP(S) scheme 和不安全路径会被拒绝；
- HTTP 和 HTTPS endpoint 均受支持；是否要求 TLS 由内部部署策略决定，传输 scheme 不改变 signing-key fingerprint 的信任边界；
- Renderer 提交设置 draft，但不能提交 artifact URL 或伪造已信任 key；
- main 连接 `<baseUrl>/.well-known/meta-agent-marketplace.json`，读取 protocol version、marketplace ID、API root、artifact origins 和 signing public key；
- 首次连接或 marketplace ID/key fingerprint 改变时，必须把 fingerprint 展示给用户并通过绑定 endpoint、marketplace ID、key 和短期 token 的二次确认保存；
- 已信任 key rotation 必须由旧 key 或内置 distribution trust root 签署，不能只因同一 URL 返回新 key 就自动接受；
- 更换活动 endpoint 不会删除旧 endpoint trust record 或卸载旧市场插件。旧插件继续按其安装时记录的 marketplace ID、base URL、artifact hash 和 key chain 管理；
- main 为所有仍有 installed plugin 的 marketplace ID 保留 inactive endpoint/trust record，并继续独立刷新其签名撤回快照；用户只能在卸载/解除管理该市场全部插件后删除该 endpoint record；
- catalog/search 只使用活动 endpoint；旧插件更新使用其 marketplace ID 对应 endpoint，不能由另一个同 plugin ID 市场接管；
- endpoint settings 使用 revision/CAS、锁和原子写入，测试连接不修改当前配置。

自定义 endpoint 是明确的供应链信任边界。HTTPS 可保护传输；用户确认的 signing-key fingerprint 负责绑定该市场后续 artifact 和撤回数据，HTTP 部署必须接受其传输不加密的运维边界。

### 8.2 API

首期至少提供：

```text
GET /.well-known/meta-agent-marketplace.json
GET /v1/plugins
GET /v1/plugins/:pluginId
GET /v1/plugins/:pluginId/versions
GET /v1/plugins/:pluginId/versions/:version
GET /v1/plugins/:pluginId/versions/:version/artifacts
GET /v1/plugins/:pluginId/versions/:version/artifacts/:artifactId/download
GET /v1/revocations
```

目录接口支持：

- `query`；
- `category`；
- `cursor`；
- `limit`；
- Desktop version；
- Pi version；
- runtime compatibility target；
- include incompatible，用于展示而非安装。

服务端必须返回稳定 plugin/version/artifact identity，不把 mutable display URL 当 identity。

### 8.3 目录 DTO

```ts
interface MarketplacePluginSummary {
  id: string;
  name: string;
  description: string;
  publisher: {
    id: string;
    displayName: string;
    verified: boolean;
  };
  categories: string[];
  iconAssetId?: string;
  latestVersion?: string;
  compatibleVersion?: string;
  containsNativeCode: boolean;
  status: "available" | "deprecated" | "withdrawn" | "blocked";
  publishedAt: number;
  updatedAt: number;
}
```

详情 DTO 额外包含版本、artifact、capability、asset、changelog、签名和撤回信息。所有 DTO 必须经过 Desktop main runtime validation 后再投影给 renderer。

### 8.4 下载 URL

- Renderer 不接收可直接请求的任意 artifact URL；
- main 只接受该 plugin installation 所属 marketplace ID 对应的已信任 endpoint API 为当前 artifact 返回的 HTTP(S) URL；catalog 新安装使用活动 endpoint，历史市场插件更新使用其保留的 inactive endpoint/trust record；
- artifact origin 必须属于已由该市场 signing key 签名的 well-known metadata；
- redirect 每一跳都必须重新验证 scheme 和 signed artifact origin，不使用编译时域名 allowlist；
- HTTP 和 HTTPS artifact origin 都必须来自已签名 metadata，且 URL 不能包含 credentials 或逃逸已信任 origin/API root；
- URL 有短期有效期，但 artifact identity 和 hash 永久稳定；
- 下载必须有 connect、idle、total timeout 和最大字节数；
- HTTP content type 不是安全判断依据，最终以签名、hash 和归档 validator 为准。

### 8.5 签名撤回快照

`GET /v1/revocations` 返回由当前 trusted market key 签名的完整快照：

```ts
interface MarketplaceRevocationSnapshot {
  marketplaceId: string;
  sequence: number;
  issuedAt: number;
  nextUpdateAt: number;
  revokedKeys: Array<{ keyId: string; reasonCode: string }>;
  pluginVersions: Array<{
    pluginId: string;
    version: string;
    artifactIds?: string[];
    status: "withdrawn" | "blocked";
    reasonCode: string;
    message: string;
    replacementVersion?: string;
  }>;
  signature: string;
}
```

- `sequence` 对同一 marketplace ID 单调递增，客户端拒绝 rollback snapshot；
- 在线检查时，过期快照必须刷新；刷新失败进入 stale/offline 状态；
- offline 默认允许已经启用的插件继续运行，但显示最后检查时间；不能使用 stale snapshot 安装、重新启用或更新一个其状态无法确认的版本；
- 收到 `blocked` 后，Desktop 阻止新 worker 加载该版本，并提示用户停止现有 session、卸载或切换到替代版本；不在 agent run 中途强杀现有 worker；
- revoked signing key 对尚未安装 artifact 立即失效。已安装版本按 signed snapshot 的 plugin status 处理，不静默删除。

### 8.6 缓存与离线

- 每个 marketplace ID 使用隔离的 endpoint/trust record、目录、artifact、asset 和 revocation cache；
- 目录缓存有获取时间、ETag 和 schema version；
- 网络失败时可以展示最近一次成功目录，但必须标记离线缓存；
- stale catalog 不能绕过 version withdrawal、revocation sequence 和 signature validation；
- 已下载且完整验证的 artifact 可以用于明确重试；
- 离线时安装只允许使用仍有完整元数据、有效签名、未过期撤回快照和 hash 的本地 verified artifact；
- 市场不可用不影响已安装插件加载。

## 9. 市场制品格式

### 9.1 归档布局

制品扩展名建议为 `.meta-plugin`：

```text
plugin.meta-plugin
├── market-manifest.json
├── signature.json
└── payload/
    ├── index.ts
    ├── package.json
    ├── node_modules/
    ├── bin/
    ├── assets/
    └── ...
```

`payload/` 解包后必须是普通 Pi extension directory：

- 默认 entry 为 `index.ts` 或 `index.js`；
- 可以包含任意 extension-owned source、data 和 dependency files；
- 可以包含预构建 `node_modules`；
- 可以包含 `.node`、`.dll`、`.dylib`、`.so`、Mach-O、ELF、PE 或脚本；
- Pi loader 与 Node module resolution 按现有行为加载这些文件；
- Desktop 不生成 dependency tree，也不修改 package metadata。

### 9.2 Manifest

```ts
interface MarketplaceArtifactManifest {
  schemaVersion: 1;
  plugin: {
    id: string;
    name: string;
    version: string;
    publisherId: string;
  };
  pi: {
    entry: string;
    extensionApi: string;
  };
  desktop: {
    hostProfileVersion: number;
    minVersion?: string;
    maxVersionExclusive?: string;
  };
  target: MarketplaceRuntimeTarget;
  capabilities: DesktopExtensionCapability[];
  nativeModules: Array<{
    path: string;
    abi: { kind: "node"; modulesAbi: string } | { kind: "napi"; minimumNapi: string };
  }>;
  executables: Array<{
    path: string;
    osRelease?: string;
    libc?: string;
  }>;
  files: Record<
    string,
    {
      sha256: string;
      size: number;
      mode: "0644" | "0755";
    }
  >;
}
```

Manifest 要求：

- plugin ID 使用稳定、大小写敏感、不可复用的市场 identity；
- version 使用合法 semver；
- `pi.entry` 必须位于 payload 内并出现在 files 中；
- 安装器必须生成 Pi CLI 可发现的根 `index.ts` 投影，该文件只静态 re-export 当前 immutable version 的 `pi.entry`；artifact 自身不得覆盖该 installer-owned projection；
- 所有 payload regular files 必须声明，不能存在额外文件；
- `nativeModules[].path` 和 `executables[].path` 必须是 files 的子集；
- 每个 native module 必须声明 `node` 或 `napi` ABI kind；Node ABI 要求精确 `modulesAbi`，N-API 要求最低 `minimumNapi`；
- Linux executable 必须声明 libc baseline，平台 binary 必须声明适用的 OS baseline；
- executable bit 只允许由 manifest 中的 `0755` 恢复；
- manifest、市场版本元数据和下载 endpoint 中的 identity 必须完全一致；
- manifest 不包含安装脚本或 post-install command。

### 9.3 Runtime target

实际 sidecar `RuntimeCompatibility` 是制品选择权威：

```ts
interface MarketplaceRuntimeTarget {
  platform: string;
  arch: string;
  nodeVersion?: string;
  osRelease?: string;
  libc?: string;
  toolchain?: string;
  piVersion?: string;
  runtimeCompatibilityId?: string;
}
```

选择规则：

1. platform 和 arch 必须精确匹配；
2. 每个 `nativeModules` 声明决定使用精确 `modulesAbi` 或最低 `napi` 匹配；
3. 一个 artifact 包含不同 ABI kind 时必须同时满足全部 native module 条件；
4. Linux artifact 必须匹配 libc family，并满足最低 baseline；
5. platform binary 必须满足 OS baseline；
6. Desktop/Pi/Host Profile 版本必须兼容；
7. 多个 artifact 都匹配时，选择条件最精确且市场标记为 preferred 的唯一 artifact；
8. 无唯一匹配时不得猜测或降级到源码构建。

市场和客户端必须使用同一套 target matching fixtures，避免服务端显示“兼容”但客户端无法安装。

### 9.4 签名

`signature.json` 至少包含：

- signing algorithm；
- key ID；
- artifact manifest hash；
- payload root hash；
- signature bytes；
- signed timestamp。

签名覆盖 canonical manifest 和完整文件表。客户端使用 endpoint 首次连接时确认并持久化的 market key，或发行构建提供的初始 trust root；支持 key rotation 和签名撤回快照。不能仅依赖 TLS、文件名或 publisher 提供的普通 checksum。

平台签名证明来源和完整性，不证明插件行为安全。

## 10. 安装位置与 scope

### 10.1 Global

使用 main 已解析的 `agentDir`：

```text
<agentDir>/extensions/<plugin-id>/
```

必须完整支持 `PI_CODING_AGENT_DIR`，不得在 renderer、preload 或市场 DTO 中拼接 `~/.pi/agent`。

### 10.2 Project

使用 Pi `CONFIG_DIR_NAME`：

```text
<project>/<CONFIG_DIR_NAME>/extensions/<plugin-id>/
```

项目安装要求：

- project 已被 Desktop/Pi trust policy 信任；
- renderer 只传 opaque project ID，不传 cwd 或 target path；
- main 通过 `ProjectStore` 解析真实 cwd；
- symlink/non-directory project root 按现有 project safety policy 处理；
- 安装不会自动创建或改变 project trust decision。

### 10.3 Directory identity 与 immutable versions

plugin ID 到目录名使用单一可逆或 registry-backed 映射。不得直接信任 plugin ID 中的 `/`、`\\`、`.` segment、Unicode separator 或平台保留名。

每个 Pi extension root 使用以下布局：

```text
<extension-root>/<plugin-id>/
├── index.ts                         # installer-owned Pi CLI active projection
├── .meta-agent-market.json          # ownership + active artifact
├── .meta-agent-versions/            # main-owned per-version verified file records
│   ├── <artifact-hash-a>.json
│   └── <artifact-hash-b>.json
└── .versions/
    ├── <artifact-hash-a>/            # immutable payload
    └── <artifact-hash-b>/            # immutable payload
```

- `index.ts` 只静态 re-export 当前 artifact 的 immutable `pi.entry`；
- Desktop `ResolvedExtensionSet.entryPath` 直接指向 `.versions/<artifact-hash>/<pi.entry>`，不经过 mutable projection；
- 安装新版本只新增 immutable version directory，再原子替换 projection/ownership；不得修改旧 version bytes；
- 已运行 worker generation 持有精确 immutable entry，插件的相对 lazy imports 和 assets 继续来自旧 version directory；
- `.meta-agent-versions/<artifact-hash>.json` 不属于插件 payload，也不进入 renderer；它保存该 immutable version 的完整 verified file record，供 GC 删除前重新验证 exact files、sizes 和 hashes；
- 只有在没有 live/metadata/pending-apply generation 引用、per-version ownership 验证通过且超过 rollback retention 后才能垃圾回收旧 version；
- 卸载先移除 active projection并从新 generation 排除插件，仍被 worker 引用的 version 延迟删除；
- 同一 scope 下一个 plugin ID 只能有一个 active projection。

### 10.4 Global/project 同 ID

同一 plugin ID 可以同时存在于 global 和 project scope。解析遵循 Pi 的 project-over-global 直觉：

- trusted project installation 显式遮蔽同 ID global installation；
- `ResolvedExtensionSet` 只包含 project entry；
- UI 同时显示两个 installation，并把 global 标记为“在当前项目中被覆盖”；
- 离开该 project 后 global entry 恢复生效；
- project entry disabled 时仍视为显式 project override，不自动回退 global，避免禁用操作意外启用另一份代码；
- duplicate ID 与 builtin/curated/development 冲突仍按 source policy 拒绝并显示诊断，不静默覆盖产品内建来源。

## 11. 本地状态模型

### 11.1 市场 registry

Desktop 使用独立 registry，不复用 Pi `settings.json`：

```ts
interface InstalledMarketplacePlugin {
  id: string;
  marketplaceId: string;
  scope: "global" | "project";
  projectId?: string;
  version: string;
  artifactId: string;
  artifactHash: string;
  entryPath: string;
  projectionPath: string;
  enabled: boolean;
  installedAt: number;
  installedFilesHash: string;
  capabilities: DesktopExtensionCapability[];
  containsNativeCode: boolean;
  state: "installed" | "update-pending" | "withdrawn" | "broken";
}
```

建议全局 registry 位于 Desktop `userData/plugins/installed.json`。project installation 仍由该 main-owned registry 记录，同时 active payload 位于 project Pi extension 目录。Registry 不是 Pi 配置，不影响普通 Pi CLI 自动发现。

### 11.2 Ownership record

每个 active plugin directory 包含 `.meta-agent-market.json`，记录：

- plugin/version/artifact identity；
- install scope；
- artifact hash；
- managed file hashes；
- installer schema version；
- installation timestamp。

该文件用于确认 Desktop 对目录有删除和更新权限。不存在有效 ownership record 的目录永远不作为市场插件覆盖或删除。

### 11.3 Revision、并发与持久恢复

- registry mutation 使用 request ID 和 expected revision/CAS；
- main 使用进程内串行队列和跨进程文件锁；
- scope target 使用 per-plugin install lock；
- 同一插件的 install/update/uninstall 不并发；
- app quit 会取消未提交下载；进入 commit 后不能假设进程一定存活，必须依赖下次启动恢复；
- stale renderer response 不覆盖新的 snapshot。

安装器维护 `userData/plugins/transactions/<operation-id>.json` write-ahead record，至少包含 before/after registry、scope、immutable version、projection、ownership 和 phase。事务状态为：

```text
prepared -> files-ready -> registry-committed -> projection-committed
                                                      |-> completed
                                                      |-> apply-pending -> apply-validated -> completed
                                                      \\-> rollback-pending
```

保证是“crash 后可恢复一致”，不是跨多个文件/filesystem 的单次原子事务：

- 每次 phase 更新使用同目录 temp、fsync、rename 和 parent-directory fsync；
- registry commit 是 Desktop desired-state commit point；
- 启动时在开放市场 IPC 或 spawn metadata/thread worker 前执行 transaction reconciliation；
- registry 已提交但 projection 未提交时按 after state 补齐 projection；
- registry 未提交时删除未引用新 version 并恢复 before projection；
- `apply-pending` 可以由与 mutation transaction 内部关联的独立 durable apply journal 承载，但二者必须在 main 内通过 operation identity 绑定；该 identity、journal、worker PID 和 before set 不得投影给 renderer；
- `apply-pending` 包含目标 project/thread、before generation、expected after generation、旧 worker identity/PID，并在 replacement bootstrap 后记录 replacement identity/PID；写入后才允许停止旧 worker；
- replacement 发布匹配 expected generation 的 bootstrap 后写 `apply-validated`；
- main 在 `apply-pending`、尚无 `apply-validated` 时崩溃，下一次启动先确认旧/replacement sidecar writer 均已退出，再保守恢复 before registry/projection 和旧 desired set；任一记录 PID 仍存活时 fail-closed，不启动第二 writer；
- `apply-validated` 表示新 generation 已完成 startup contract；reconciliation 可以完成 after state，不回滚成功应用；
- rollback-pending 幂等恢复 before registry/projection；
- reconciliation 完成后重新校验 ownership、entry hash 和 immutable directory；
- 无法证明 before/after 任一状态完整时标记 `broken`，禁止加载并保留诊断，不猜测删除用户文件。

## 12. 安装事务

### 12.1 阶段

```text
resolving
-> downloading
-> verifying-artifact
-> extracting
-> verifying-payload
-> awaiting-confirmation
-> committing
-> applying
-> completed | rolled-back | failed
```

### 12.2 安装与更新流程

1. main 读取当前 market metadata、签名撤回快照和 runtime compatibility；
2. 解析唯一兼容 artifact；
3. 检查 publisher、版本、marketplace identity、withdrawal 和 Desktop/Pi compatibility；
4. 下载到 Desktop cache，并复制到目标 extension root 同 filesystem staging；
5. 校验 artifact size、hash 和签名；
6. 以不跟随归档 symlink 的方式解包到新的 staging directory；
7. 校验 manifest schema、identity、target、文件数、大小和每个文件 hash；
8. 使用 disposable metadata worker 对 immutable entry 执行 Desktop Host Profile load probe；
9. 检查目标 ownership 和用户修改；
10. 获取用户需要的 full-trust/native/update disclosure 确认；
11. 写入 `prepared` transaction record；
12. 将 staging 原子 rename 为新的 `.versions/<artifact-hash>` 并 fsync parent；
13. 写入 `files-ready`；
14. 原子更新 market registry，写入 `registry-committed` commit point；
15. 原子替换 Pi CLI `index.ts` projection 和 ownership，写入 `projection-committed`；
16. 计算新的 `ResolvedExtensionSet`；
17. 如果用户选择立即应用，先持久化 `apply-pending`，再只 replacement 目标 session；其他 live workers继续引用旧 immutable version；
18. replacement 发布匹配 expected generation 的 bootstrap 后持久化 `apply-validated`；
19. 目标 session 启动失败时恢复该 session 的旧 set，并将 transaction 标记为 rollback-pending；main 恢复 before registry/projection，已经引用新 version 的其他 worker允许完成但新 worker不再加载；
20. 无立即 apply 时 operation 以 `reload-required` 完成，旧 version 按 retention 保留；
21. 最终写 `completed`，按 generation references 和 retention 清理旧 versions/staging。

不能跨 filesystem 依赖 rename 原子性。下载 cache 可以位于 `userData`，但解包后的 commit staging 必须位于目标 extension root 的 installer-owned sibling。所有跨文件状态通过 transaction journal 恢复，不声称 directory、registry、projection 和 worker replacement 是单个原子操作。

### 12.3 卸载流程

1. 校验 registry、ownership 和 managed file hashes；
2. 处理用户修改确认；
3. 写 before/after transaction，其中 after registry 不含该 installation；
4. 原子提交 registry；
5. 移除或改名 Pi CLI root `index.ts` projection，使新 Pi/ Desktop worker不再发现；
6. 保留 ownership tombstone 和仍被 generation 引用的 immutable versions；
7. 当前 session 立即 apply 时执行 replacement；失败只恢复该 session旧 set，并将 uninstall transaction 回滚到 before registry/projection；
8. 没有 session 或不立即 apply 时返回 `reload-required`，不是“已从所有运行进程卸载”；
9. 所有引用释放后删除 immutable versions、ownership 和空 plugin root；
10. crash 后由相同 transaction reconciliation 幂等继续或回滚。

### 12.4 归档安全

安装器必须拒绝：

- absolute path；
- `..` traversal；
- Windows drive/UNC path；
- NUL、非法编码或 normalization collision；
- symlink、hardlink、device、FIFO 和 socket archive entry；
- 大小写不敏感 filesystem 上的文件名 collision；
- manifest 未声明文件；
- 文件数、单文件、总压缩大小、总解压大小或压缩比超限；
- hash、size、mode 或 identity 不一致；
- entry 不在 payload 内；
- target 不兼容；
- signature 无效、过期 key 或 revoked key。

### 12.5 用户修改保护

更新和卸载前重新计算 managed files：

- 全部匹配 ownership record：允许继续；
- 存在修改、删除或额外文件：默认阻止覆盖/删除；
- 用户可以选择保留目录并从市场 registry 中解除管理；
- 强制覆盖或强制卸载必须二次确认，并明确列出受影响文件数量；
- 不把用户修改自动复制到新版本；
- backup 和 diagnostics 不记录文件正文。

## 13. 更新、降级与撤销

### 13.1 更新检查

- Desktop 启动后延迟检查，不阻塞首屏和 session attach；
- 周期检查与手动刷新共享 single-flight；
- 只比较兼容 artifact；
- update metadata 失败保留当前安装状态；
- 首期默认不自动安装更新；
- 用户可以在插件中心逐项或批量确认更新。

### 13.2 更新事务

更新复用完整安装验证，不允许 patch 在未验证文件上就地修改。新版本进入新的 immutable version directory，验证完成后切换 registry 和 Pi CLI projection；旧 version 在 generation 引用和 rollback retention 结束前保留。

更新出现以下变化时必须重新确认：

- publisher identity；
- 新增 capabilities；
- 首次加入 native module；
- 首次加入 executable；
- scope 改变；
- signing key 不属于已信任 rotation chain。

### 13.3 降级

用户只能降级到市场仍提供、签名有效且与当前 runtime 兼容的版本。降级与更新使用同一事务和用户修改保护，不提供任意本地 artifact 选择器。

### 13.4 撤回

市场版本状态：

```text
available
deprecated
withdrawn
blocked
```

- `deprecated`：允许继续运行和安装，但显示替代建议；
- `withdrawn`：禁止新安装，已安装用户看到高优先级警告；
- `blocked`：用于确认存在严重风险的版本。Desktop 禁止重新启用或应用该版本，但不静默删除文件；用户可以卸载、解除管理或在明确的离线恢复流程中查看原因；
- 撤回信息必须包含 stable reason code、说明、发布时间和建议版本；
- 客户端不能只依赖可过期 catalog cache 判断 blocked 状态，在线时必须读取签名撤回数据。

## 14. 与 Desktop 受控加载集成

### 14.1 Source type

```ts
type DesktopExtensionSource =
  | "builtin"
  | "curated"
  | "marketplace"
  | "development";
```

Marketplace entry 至少包含：

```ts
interface DesktopMarketplaceExtensionEntry {
  id: string;
  displayName: string;
  source: "marketplace";
  marketplaceId: string;
  version: string;
  scope: "global" | "project";
  entryPath: string;
  contentHash: string;
  artifactHash: string;
  hostProfileVersion: number;
  capabilities: DesktopExtensionCapability[];
}
```

### 14.2 Source policy

Desktop 继续设置 `noExtensions: true`，不重新打开 Pi 普通 global/project auto-discovery。原因是市场安装目录对普通 Pi CLI 可自动发现，但 Desktop 仍需保证：

- 只有 registry 中已安装且 enabled 的 marketplace entry 进入 worker；
- renderer 不能通过在目录中放文件绕过批准；
- draft/live 使用相同 marketplace set；
- blocked、broken 或未确认更新不能加载；
- generation 对应精确 marketplace ID、plugin ID、version、immutable entry path 和 content hash；
- project marketplace entry 按第 10.4 节遮蔽同 ID global entry；
- source policy 为每个 generation 注册 immutable version reference，供垃圾回收判断。

`DesktopExtensionSourcePolicy` 验证 marketplace path 必须位于对应 scope 的标准 Pi extension root 下 `.versions/<artifact-hash>`，ownership、registry、entry hash 和 artifact identity 必须一致。

### 14.3 Pi CLI 可见性

市场安装结果位于 Pi 标准 extension 目录，installer-owned root `index.ts` 静态 re-export 当前 immutable version，因此普通 Pi CLI 会按 Pi 原有规则发现它。实际 Pi CLI discovery fixture 是发布门槛，不能只靠 Desktop `additionalExtensionPaths` 测试。Desktop 市场 enable/disable 状态只控制 Desktop 受控 set，不修改 Pi CLI 的 discovery 设置。

产品 UI 必须准确说明这个边界：

- “在 Desktop 中禁用”不等于从 Pi CLI 禁用；
- “卸载”会删除标准目录，因此同时影响 Desktop 和 Pi CLI；
- project scope 插件遵循 Pi project trust；
- 如未来需要共享 enable state，必须另立规范，不得静默修改 Pi settings。

### 14.4 Apply

安装、更新、卸载和 enable mutation 默认影响新 worker。已经运行的其他 session 继续引用旧 immutable version，直到各自 replacement/退出。存在 return session 时允许用户选择“应用到当前会话”，复用现有：

- abort confirmation；
- old worker stop；
- single-writer release；
- replacement startup；
- generation rejection；
- bootstrap/resync；
- startup failure rollback。

### 14.5 Marketplace provider extensions

为保证标准 Pi Extension 自由度，marketplace source 允许声明并调用 `providers.register`。这项决策取代受控扩展规范中“providers 仅对 builtin/curated 提供产品支持”的限制：

- Marketplace artifact 必须声明 `providers.register` capability；
- Desktop Host Profile 对 marketplace provider registration 提供与 curated 相同的 contract tests；
- provider credential、OAuth 和 model side effects 仍遵循 Pi public API 与现有 Desktop provider/auth contracts；
- capability 仍不是强调用隔离，未声明调用属于 artifact 审核和 diagnostics 问题；
- TUI-only provider setup UI 不因此自动兼容 Desktop。

## 15. 全信任安全模型

### 15.1 插件能力

Marketplace extension 可以：

- 读取和修改 sidecar 用户可访问文件；
- 读取环境变量；
- 发起网络请求；
- 创建监听端口；
- 启动和管理子进程；
- 加载 `.node` 模块；
- 执行自带平台二进制；
- 调用 Desktop Host Profile 支持的 Pi Extension API；
- 消耗 CPU、内存、磁盘和网络；
- 使 metadata/thread worker 崩溃或挂起。

这些能力是保证 Pi Extension 自由度的有意设计，不通过虚假 permission layer 隐藏。

### 15.2 Capability disclosure

`capabilities` 用于：

- Host compatibility；
- 市场审核；
- 用户展示；
- regression tests；
- 更新差异确认。

它不限制插件直接使用 Node API，也不能可靠归因共享 runner 中的每次调用。UI 禁止使用“仅可访问”“已隔离”“sandboxed”等误导文案。

### 15.3 进程边界

- 插件只在 metadata/thread sidecar 中加载；
- Electron main、preload 和 renderer 不 import、require 或 evaluate 插件；
- thread 插件故障主要影响对应 thread worker；
- metadata 插件故障可能影响 draft discovery，registry 按现有策略重启 metadata worker；
- sidecar 进程隔离是故障边界，不是 OS 权限 sandbox。

### 15.4 Native code

- native artifact 必须由市场 artifact 签名和 file hash 覆盖；
- macOS native code 应满足当前发布渠道所需 code signing/notarization；
- Windows binary 应支持 Authenticode publisher verification，市场仍以 artifact 签名为安装权威；
- Linux artifact 必须声明 libc 和 OS baseline；
- installer 不主动执行 native binary 做探测；
- runtime startup failure 通过 replacement rollback 处理；
- 安全软件或 OS policy 阻止加载时显示可诊断错误，不建议用户全局关闭系统保护。

## 16. Main、Preload 与 Renderer 合同

### 16.1 Main services

建议新增：

```text
src/main/plugins/plugin-marketplace-service.ts
src/main/plugins/plugin-artifact-downloader.ts
src/main/plugins/plugin-artifact-validator.ts
src/main/plugins/plugin-installer.ts
src/main/plugins/plugin-registry-service.ts
src/main/plugins/plugin-target-matcher.ts
src/main/plugins/plugin-transaction-reconciler.ts
src/main/plugins/marketplace-endpoint-settings-service.ts
```

职责必须分离：

- marketplace service 只处理远端 catalog DTO 和 cache；
- downloader 只处理受控 URL、限额和进度；
- validator 只处理 schema、signature、archive 和 file integrity；
- installer 只处理 staging、ownership、journaled commit 和 rollback；
- registry service 只处理本地 revision/CAS state；
- transaction reconciler 在 worker 启动前恢复未完成事务；
- endpoint settings service 处理活动/历史 Base URL、well-known discovery、连接测试、fingerprint confirmation、per-market revocation refresh 和 CAS；
- source policy 只把已验证 registry 投影为 `ResolvedExtensionSet`。

### 16.2 Shared contracts

建议新增：

```text
src/shared/plugin-marketplace-contracts.ts
```

核心 API：

```ts
interface DesktopPluginMarketplaceApi {
  getEndpointSettings(): Promise<MarketplaceEndpointSettingsSnapshot>;
  testEndpoint(input: TestMarketplaceEndpointInput): Promise<TestMarketplaceEndpointResult>;
  saveEndpoint(input: SaveMarketplaceEndpointInput): Promise<SaveMarketplaceEndpointResult>;
  list(input: ListMarketplacePluginsInput): Promise<MarketplacePluginPage>;
  get(pluginId: string): Promise<MarketplacePluginDetail>;
  getInstalled(): Promise<InstalledPluginSnapshot>;
  install(input: InstallMarketplacePluginInput): Promise<PluginMutationResult>;
  update(input: UpdateMarketplacePluginInput): Promise<PluginMutationResult>;
  uninstall(input: UninstallMarketplacePluginInput): Promise<PluginMutationResult>;
  setEnabled(input: SetMarketplacePluginEnabledInput): Promise<PluginMutationResult>;
  apply(input: ApplyDesktopExtensionSetInput): Promise<ApplyDesktopExtensionSetResult>;
  subscribeProgress(listener: (event: PluginOperationProgress) => void): () => void;
}
```

Endpoint save 使用 request ID、expected settings revision 和 fingerprint confirmation token；插件 mutation 使用 request ID、expected registry revision 和明确 scope。Renderer 可以提交 Marketplace API Base URL draft，但不传：

- filesystem path；
- artifact URL；
- raw signing public/private key；
- raw manifest；
- executable command；
- resolved extension entry。

### 16.3 IPC

- main 对全部 input 做 runtime validation；
- endpoint URL 只通过 settings contract 进入 main，不能在 list/install mutation 中临时覆盖；
- operation progress 带 operation ID、plugin ID、phase 和 bounded message；
- renderer 只能订阅自己 webContents 发起的 operation；
- window destroyed 后取消订阅并清理 renderer-owned download request；
- IPC error 不包含绝对 user path、环境变量或插件文件正文；
- main service 可在没有任何 session 的设置/插件路由中工作。

### 16.4 Renderer assets

当前 CSP 不允许任意公网图片。市场 icon/preview 由 main 下载、验证 content type/size 并缓存，再通过受控自定义协议或 opaque asset handle 提供给 renderer。

- Renderer 不直接 `<img src="https://...">`；
- SVG 首期不作为远程市场图片格式；
- 支持 PNG、JPEG、WebP 和受限 GIF；
- 视频预览不属于首期；
- asset failure 使用稳定占位，不影响插件操作。

## 17. 状态与错误体验

### 17.1 页面状态

至少覆盖：

```text
catalog-loading
catalog-ready
catalog-stale
catalog-offline
detail-loading
install-confirmation
installing
installed
update-available
updating
uninstalling
reload-required
applying
rolled-back
incompatible
withdrawn
blocked
modified-locally
operation-error
```

### 17.2 错误分类

稳定错误 code 至少包括：

- `MARKETPLACE_ENDPOINT_INVALID`；
- `MARKETPLACE_ENDPOINT_UNTRUSTED`；
- `MARKETPLACE_IDENTITY_CHANGED`；
- `MARKETPLACE_KEY_CONFIRMATION_REQUIRED`；
- `MARKETPLACE_UNAVAILABLE`；
- `MARKETPLACE_RESPONSE_INVALID`；
- `MARKETPLACE_REVOCATION_STALE`；
- `MARKETPLACE_REVOCATION_ROLLBACK`；
- `PLUGIN_NOT_FOUND`；
- `PLUGIN_VERSION_WITHDRAWN`；
- `PLUGIN_VERSION_BLOCKED`；
- `PLUGIN_ARTIFACT_INCOMPATIBLE`；
- `PLUGIN_ARTIFACT_TOO_LARGE`；
- `PLUGIN_ARTIFACT_SIGNATURE_INVALID`；
- `PLUGIN_ARTIFACT_INTEGRITY_MISMATCH`；
- `PLUGIN_ARCHIVE_UNSAFE`；
- `PLUGIN_TARGET_OCCUPIED`；
- `PLUGIN_INSTALLATION_MODIFIED`；
- `PLUGIN_REGISTRY_CONFLICT`；
- `PLUGIN_INSTALL_ROLLED_BACK`；
- `PLUGIN_APPLY_ROLLED_BACK`；
- `PROJECT_NOT_TRUSTED`。

用户文案说明下一步，不显示内部 stack。Diagnostics 保留 operation ID，便于本地日志关联。

## 18. 隐私、日志与指标

### 18.1 隐私

市场请求默认可以包含：

- Desktop version；
- Pi version；
- runtime target；
- locale；
- query、category 和 pagination。

不得包含：

- project path/name；
- session/thread ID；
- prompt 或消息正文；
- 环境变量；
- API key/auth data；
- 本地插件源码；
- Developer Mode entry path。

下载认证如需要 token，由 main 安全存储并添加，renderer 不接收。

### 18.2 本地日志

记录：

- operation ID；
- plugin/version/artifact ID；
- scope 类型，不记录 project path；
- phase 和 duration；
- target compatibility 摘要；
- hash 前缀；
- result code 和 rollback 状态。

不记录完整下载 URL query、签名 secret、文件正文、环境变量或插件 stdout 全量内容。

### 18.3 产品指标

如产品启用 telemetry，可统计匿名聚合：

- catalog 请求成功率和延迟；
- 搜索到详情转化；
- install/update/uninstall 成功率；
- target incompatible 比例；
- signature/integrity failure；
- apply rollback；
- native 与 pure JS artifact 占比。

指标受现有 Desktop telemetry opt-out 控制，不创建独立不可关闭通道。

## 19. 发布与市场治理

### 19.1 发布准入

首期协议采用“市场运营方审核发布”模型。运营方可以是默认建议市场或用户配置的自托管市场，不绑定特定域名：

- publisher identity 已登记；
- manifest 和版本合法；
- artifact 可重复关联到提交或发布源；
- 每个 target artifact 完成 signature/hash；
- pure JS 和 native content 都经过自动扫描；
- native artifact 有明确 build provenance；
- 插件说明披露外部服务、credential 和 destructive behavior；
- 至少通过对应 Desktop Host Profile smoke；
- 已知恶意、混淆规避审核或下载二阶段未声明可执行代码的插件拒绝发布。

市场运营方审核降低风险，但不改变客户端 full-trust 声明。Desktop 通过用户确认的 marketplace identity/key fingerprint 建立信任，不因 endpoint 使用自定义域名而降低 artifact validation。

### 19.2 不可变性

- 已发布 plugin ID/version/artifact ID 对应内容不可覆盖；
- 修复必须发布新版本；
- display metadata 可以审计更新，但 artifact hash 不变；
- CDN 内容必须以 immutable cache policy 分发；
- 市场数据库和 object storage 都保留 artifact identity/hash 约束。

### 19.3 Key rotation

- 发行构建可以内置初始建议市场 trust root，但自定义 endpoint 使用首次确认并持久化的 fingerprint；
- 新 signing key 通过该 marketplace 已信任旧 key 或 distribution trust root 的 rotation statement 引入；
- compromised key 可以被单调签名撤回快照撤销；
- endpoint 更换、marketplace ID 变化和未签名 key replacement 必须重新确认；
- 离线客户端不会获得虚假的“仍安全”保证，UI 显示撤回状态最后检查时间。

## 20. 分阶段实施

### Phase 0：规范与 compatibility fixtures

- 修订受控扩展和 sidecar spec 冲突，并将同步修订作为 Phase 0 exit gate；
- 固化 market manifest、signature 和 runtime target schema；
- 建立 sidecar `RuntimeCompatibility` target fixtures；
- 建立纯 JS、N-API、Node ABI 和 executable 示例 artifacts；
- 确认 global/project path 与 `PI_CODING_AGENT_DIR`；
- 固化可配置 endpoint well-known、fingerprint confirmation 和 signed revocation schema；
- 固化 immutable version projection、transaction journal 和 startup reconciliation。

完成条件：服务端和客户端对相同 fixture 给出一致 target 选择和拒绝原因；既有 normative specs 已同步修改，不再禁止市场、预构建依赖或 native artifact。

### Phase 1：本地 artifact installer

- 实现 registry、ownership、archive validator 和 installer；
- 使用测试 fixture 模拟已下载 artifact，不接公网市场；
- 接入 marketplace source policy；
- 实现 global/project install、update、uninstall 和 rollback；
- 保持 Pi loader 不变。

完成条件：标准 Pi extension 安装到标准目录后，Desktop 通过受控 set 加载，Pi CLI 可按原规则发现。

### Phase 2：市场 API 与下载

- 实现 catalog client、cache、target resolution 和 downloader；
- 实现 signature/key rotation；
- 实现 progress IPC；
- 实现 offline/stale behavior；
- 实现 withdrawal 状态。

完成条件：Desktop 可以从 Settings 配置并信任市场 endpoint，从该服务下载 pure JS/native artifacts，并在 crash 后恢复到一致状态。

### Phase 3：插件中心 UI

- 新增 `/plugins` 和详情路由；
- 实现搜索、分类、已安装、可更新；
- 实现 full-trust/native disclosure；
- 实现 Marketplace API URL、连接测试、fingerprint confirmation、scope、progress、diagnostics 和 apply；
- 实现受控 market asset protocol/cache；
- 保持 settings route 不 attach session。

完成条件：用户无需终端即可完成完整安装生命周期，并能恢复更新失败。

### Phase 4：更新与治理

- 实现周期 update check；
- 实现 deprecated/withdrawn/blocked；
- 实现批量更新与新增风险确认；
- 实现 publisher/key revocation；
- 补齐发布审核和操作手册。

完成条件：已发布风险版本可以被可靠阻止新安装并通知已安装用户。

## 21. 测试要求

### 21.1 Manifest 与 target matcher

- valid pure JS artifact；
- required Pi CLI root projection and actual CLI discovery；
- exact Node ABI；
- minimum N-API；
- platform/arch mismatch；
- glibc/musl mismatch；
- OS baseline；
- Desktop/Pi/Host Profile mismatch；
- ambiguous artifact；
- missing artifact；
- schema/version/identity mismatch。

### 21.2 Archive validator

- traversal、absolute、UNC、drive path；
- symlink、hardlink、device 和 FIFO；
- Unicode normalization 和 case collision；
- zip bomb 和 size/file-count limit；
- undeclared/missing file；
- file size/hash/mode mismatch；
- invalid entry；
- valid `.node` 和 executable；
- invalid/revoked signature；
- key rotation。

### 21.3 Installer

- global/project install；
- custom agentDir；
- untrusted project；
- target occupied by unmanaged directory；
- idempotent request ID；
- revision conflict；
- concurrent same-plugin mutation；
- app interruption in every transaction phase；
- fsync/rename/write failure；
- staging cleanup；
- ownership creation；
- locally modified installation；
- update/downgrade/uninstall；
- old directory rollback；
- registry and directory consistency recovery；
- journal recovery from every persisted phase, including apply-pending/apply-validated crash boundaries；
- immutable version retention and generation-aware garbage collection；
- uninstall with no session、deferred apply and delayed deletion。

### 21.4 Source policy 与 worker

- marketplace source merge/order/duplicate ID；
- disabled/broken/blocked exclusion；
- scope root validation；
- ownership/hash mismatch；
- draft/live consistency；
- stale draft generation；
- metadata worker load failure；
- current session apply；
- old worker single-writer release；
- new version startup failure rollback；
- native module load success/failure fixture；
- immutable lazy import/assets remain available to old generation；
- project-over-global shadowing and disabled project override；
- marketplace `providers.register` contract。

### 21.5 Market client 与 IPC

- API schema validation；
- endpoint URL normalization、HTTP/HTTPS、credentials/query/fragment 和不安全路径拒绝；
- well-known discovery、marketplace identity 和 first-connect fingerprint confirmation；
- endpoint/settings revision conflict and test-without-save；
- active endpoint switching preserves inactive endpoint/trust/revocation records for installed plugins；
- signed artifact origins、redirect validation and endpoint switching；
- pagination/search/category；
- timeout 和 max size；
- ETag/stale/offline cache；
- signed monotonic revocation snapshot、expiry、rollback attack 和 blocked active-worker behavior；
- renderer 只能通过 settings contract 提交 Base URL，不能提交 artifact URL/raw key；
- progress isolation by webContents；
- destroyed window cleanup；
- bounded sanitized errors。

### 21.6 Renderer

- route/provider 生命周期且不 attach session；
- Settings endpoint URL、connection test、fingerprint confirmation、identity/key change and conflict；
- catalog loading/ready/stale/offline；
- search、category、installed 和 updates；
- detail compatibility/native disclosure；
- global/project scope；
- untrusted project state；
- install/update/uninstall confirmation；
- operation progress；
- modified installation；
- reload-required/apply/rollback；
- withdrawn/blocked；
- keyboard、focus、ARIA；
- light/dark/system；
- 1440x920、1024x680 和窄窗口无重叠。

## 22. 验证命令

文档变更：

```bash
git diff --check
```

实现阶段修改测试文件后运行具体测试：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

代码实现完成后：

```bash
npm --prefix packages/desktop run generate-routes
npm --prefix packages/desktop run typecheck
npm run check
git diff --check
```

不得默认运行根 `npm test`、完整 Vitest 或 `npm run build`。Native fixture 构建属于发布/fixture pipeline，不在用户安装流程执行。

## 23. 验收标准

全部满足才视为首期联网插件市场完成：

1. 插件中心可以使用 Settings 中配置的 Marketplace API Base URL 联网搜索、浏览和查看插件详情，业务实现不绑定固定域名。
2. Endpoint 配置支持 HTTP/HTTPS URL 规范化、结构安全校验、连接测试、marketplace identity、首次 signing-key fingerprint 确认和 revision/CAS。
3. 市场只使用应用自有 API/artifact，不调用 Pi npm/git package manager。
4. 安装过程不运行 npm、lifecycle script 或源码构建。
5. 安装后的插件仍是标准 Pi Extension，Pi extension loader/runner 无市场专用分支。
6. Global/project payload 位于 Pi 标准 extension 目录的 immutable version 下，并支持 custom agentDir 和 project trust。
7. Desktop 继续关闭普通 extension auto-discovery，只加载 registry 批准的 marketplace immutable entry。
8. Installer 生成根 `index.ts` projection，真实 Pi CLI discovery fixture 证明普通 Pi CLI 可以发现当前版本。
9. Renderer 不能提交路径、artifact URL、raw signing key 或 resolved entry。
10. Artifact 经过已确认 market key 的签名、总 hash、manifest 和逐文件校验。
11. Archive traversal、link、collision、bomb 和 undeclared file 被拒绝。
12. Pure JS、N-API、Node ABI `.node` 和平台 executable 都有明确 target matching。
13. 不兼容 artifact 不安装、不编译、不猜测降级。
14. 安装、更新和卸载使用 revision、lock、same-filesystem staging、write-ahead journal、commit point 和 startup reconciliation，提供 crash 后可恢复一致而非虚假跨文件原子性。
15. 用户修改过的 managed directory 不会被静默覆盖或删除。
16. Worker generation 引用 immutable version；旧 generation 的 lazy import/assets 在更新后仍可用，垃圾回收等待全部引用释放。
17. 新版本 apply 失败后恢复目标 session 旧 set，并由 transaction rollback 恢复 desired registry/projection。
18. Global/project 同 ID 使用 project-over-global，disabled project override 不回退 global。
19. Marketplace extension 支持并测试 `providers.register`，同时不扩展未实现的 TUI Host API。
20. 安装前准确展示 full-trust 和 native code 风险，不使用 sandbox 误导文案。
21. Capability disclosure 不被描述为 Node/OS 权限限制。
22. 市场不可用不影响已安装插件和聊天功能。
23. Signed monotonic revocation snapshot 对 withdrawn/blocked、offline、expiry 和 rollback attack 有稳定行为。
24. 插件代码不进入 Electron main、preload 或 renderer。
25. Draft/live 使用相同 marketplace extension set 和 generation。
26. 页面、endpoint settings、service、validator、installer、reconciler、IPC、source policy 和 worker rollback 有 focused tests。
27. `desktop-controlled-extensions-spec.md` 与 `node-sidecar-per-thread-spec.md` 已同步修订，不再保留冲突 normative requirements。
28. Desktop typecheck、根 `npm run check` 和 `git diff --check` 通过。

## 24. 后续演进

以下能力必须单独立项：

- 第三方 publisher 自助注册和上传；
- 公开评分、评论和举报；
- 付费插件、订阅和 entitlement；
- 插件 renderer UI contribution；
- shared Desktop/Pi CLI enabled state；
- delta artifact；
- 自动后台安装更新；
- per-extension OS sandbox；
- native artifact remote attestation；
- 企业私有市场和组织 policy。

这些能力不能改变本规范的基础边界：市场负责分发，Pi 负责 extension execution，Desktop source policy 负责受控加载，插件在运行时保持标准 Pi Extension。
