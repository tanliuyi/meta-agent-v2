# Meta Agent Desktop Plugin Call 规范

> 状态：Draft
>
> 适用范围：`packages/desktop` 的插件制品协议、受控插件加载、thread sidecar、Pi timeline 投影和 Desktop tool UI
>
> 目标版本：Desktop Extension Host Profile v1 的增量能力
>
> 设计目的：减少模型初始可见 tool schema 的数量和 token，占用一个固定 `plugin_call` tool 承载 Desktop 插件方法；Pi 内建工具保持原样。

## 1. 摘要

Desktop 插件可以通过 entry module 的 `desktopPlugin` 命名导出声明只供程序调用的结构化方法。Desktop 受控 loader wrapper 读取这些 declarations，将所有已启用插件的方法放入当前 thread worker generation 的 session-scoped registry，但不调用 Pi API 注册这些方法，也不把它们放入模型 tool schema。模型只看到 Desktop inline extension 通过现有 `pi.registerTool()` 注册的一个固定 `plugin_call` tool，并通过 TypeScript 程序调用：

```ts
const page = await plugin.browser.get({
  url: "https://www.google.com",
});

return {
  title: `${page.title} - Google Search`,
  content: page.content,
};
```

插件同时携带 Pi skill。初始 system prompt 只包含 skill 的 `name`、`description` 和文件位置；完整方法签名、约束、示例和工作流保留在 `SKILL.md` 及其 references 中，由模型在需要时使用现有 `read` 工具加载。

核心定位：

```text
Pi built-in tools
    = 继续直接暴露给模型并按现有 agent loop 执行

PluginMethodRegistry
    = 当前 extension generation 中可由程序调用的方法

plugin_call
    = 唯一的 Desktop 插件方法模型入口

plugin.<pluginId>.<method>(args)
    = plugin_call worker 中的动态异步 API

Plugin SKILL.md
    = 按需披露的方法签名、语义和工作流
```

这不是 PTC（Programmatic Tool Calling）模式。Desktop 不把 `read`、`bash`、`edit`、`subagent` 等 Pi 工具折叠到代码执行器，也不增加统一 `run_code`。聚合边界只覆盖 Desktop 从插件 module `desktopPlugin.methods` 命名导出中接纳的方法。

## 2. 规范优先级

本规范是 Desktop plugin method aggregation 的 authority。与既有规范的关系如下：

- [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 继续负责 main-owned approved entry set、Host Profile、Developer Mode、extension capabilities 和 immutable worker generation；
- [`plugin-marketplace-product-spec.md`](./plugin-marketplace-product-spec.md) 继续负责 Marketplace 分发、安装、版本目录、registry、更新和卸载；
- [`node-sidecar-per-thread-spec.md`](./node-sidecar-per-thread-spec.md) 继续负责 Electron embedded Node、thread single writer、worker replacement、sidecar protocol 和进程生命周期；
- [`pi-native-assistant-ui-runtime-spec.md`](./pi-native-assistant-ui-runtime-spec.md) 继续负责 Pi message/tool lifecycle 到 Desktop timeline 和 assistant-ui 的投影；
- Pi `AgentSession`、extension API、extension runner、agent loop、tool validation、session JSONL 和 compaction 语义保持权威且不作任何修改；
- 本规范只新增 hidden plugin methods、插件 skill admission、`plugin_call` runtime 和对应 UI details。

当本规范进入 Accepted 并开始实现时，Marketplace 规范中“插件只使用现有 tools/commands/events/providers API”的描述需要扩展为：插件仍可使用原有 Pi API，同时可提供由 Desktop wrapper 读取的 `desktopPlugin` module declaration；“不改写 Pi extension registration”继续成立。其余运行模型不变。

本规范同时对 sidecar no-orphan 条款作一个窄化：host-owned descendants、插件经 Host API 启动的 descendants，以及生成代码通过受支持 `node:child_process` wrapper 启动的 descendants 仍必须在 outer run/dispose 时清理；拥有完整 Node authority 并故意绕过 wrapper、daemonize 或重新脱离进程组的代码不在可强制保证范围。该例外必须在产品全信任说明中明确，不能把 worker thread 描述成安全边界。

## 3. 目标

### 3.1 产品目标

1. 无论启用多少个 method-based Desktop 插件，模型最多新增一个 `plugin_call` tool schema。
2. 单个插件方法的名称、参数 schema 和结果 schema 不进入初始模型 tool list。
3. 模型根据任务选择并读取相关 plugin skill，不预加载所有插件 API 文档。
4. Pi 内建工具继续直接可见、直接执行，不改变现有提示词和交互习惯。
5. 插件调用在 Desktop tool row 中保持可观察，包括程序描述、子调用、耗时、失败和附件。
6. 插件方法使用稳定的结构化 JSON 输入和输出，避免解析面向模型的文本结果。

### 3.2 工程目标

1. plugin registry 与 `ResolvedExtensionSet.generation`、project 和 thread 绑定。
2. 只有 main 批准，且 Desktop wrapper 成功导入、校验并加载的插件可以贡献 methods 和 skills。
3. 参数和结果分别经过 TypeBox schema 校验及 lossless JSON 校验。
4. abort、wall/compute timeout、worker termination、heap cap、调用数限制和输出限制有明确语义。
5. 中间 method result 只在 code worker 与 sidecar dispatcher 之间流动，不追加为 Pi tool result 或 conversation message。
6. 一个 `plugin_call` 只产生一个 Pi tool lifecycle；内部方法调用作为 UI/audit details，不伪造成嵌套 Pi tools。
7. reload、replacement 和 worker crash 后不复用旧 generation 的 registry、handler、signal 或结果。

## 4. 非目标

首期不包括：

- 修改 `packages/ai`、`packages/agent`、`packages/coding-agent`、`packages/tui` 或任何 Pi public/private API；
- 通过 `pi.registerPluginMethod()`、扩展 `ExtensionAPI`、修改 `ExtensionRunner` 或增加 `ResourceLoader` hook 来保存 plugin methods；
- 把 Pi built-in tools 或普通 extension `registerTool()` tools 聚合进 `plugin_call`；
- 兼容 DeepSeek Harness PTC 的 `run_code` schema、SDK 或调度协议；
- 在 renderer、preload 或 Electron main 中执行插件或模型生成代码；
- 为生成代码提供权限 sandbox、文件隔离、网络隔离或 secret 隔离；
- 靠 capability declaration 防止恶意插件或恶意生成代码访问操作系统；
- 自动把所有 TypeBox schemas 或 generated SDK 注入 system prompt；
- 在一个 live generation 内增删 methods 或热更新 skill；
- 让 metadata worker、cold session 操作或首期 programmatic subagent 调用 thread 插件方法；
- 把文件二进制作为 LLM content block 发送给 provider；
- 对故意绕过 host child-process wrapper 的恶意生成代码提供 no-orphan 安全保证。受支持的 subprocess API 仍必须跟踪和清理所有 descendants；这一限制来自全 Node authority，不影响正常 timeout/dispose 的 cleanup contract。

## 5. 不变量

实现必须保持以下不变量：

1. `plugin_call` 之外的 Pi active tool set 与本功能启用前一致。
2. method-based 插件数量从 1 增加到 N 时，模型 tool schema 数量不随 N 增加。
3. `DesktopPluginMethodDefinition.parameters`、`result`、method description 和 generated catalog 不进入初始 system prompt。
4. 初始 prompt 对每个 admitted skill 只使用 Pi 现有 skill metadata 格式。
5. registry key 使用 Desktop 批准的 canonical plugin ID；插件代码不能自报或覆盖 plugin ID。
6. `plugin_call` 是 Desktop 保留 tool name。Desktop 只向现有 Pi loader 注入一个同名 inline factory；不修改 Pi 去追踪 tool owner。若现有 Pi loader 因同名 tool 冲突返回 load error，Desktop 将其作为 blocking startup diagnostic，不覆盖、first-win 或静默替换其他 tool。
7. 相同 canonical plugin ID 下的 method name 唯一；冲突是 Desktop admission failure，不使用 first-wins。
8. 生成代码不能调用当前 generation 中未接纳的方法，即使磁盘上存在另一个版本的插件或 skill。
9. method 输入和输出都必须是 lossless JSON；`undefined`、`bigint`、function、symbol、循环引用、`NaN` 和 infinity 被拒绝。
10. 只有 outer program 的显式 `return` 值及允许的 image content 进入模型 tool result；中间结果、audit records 和 console logs 不进入模型上下文。
11. sidecar 向 renderer 发送的数据继续满足现有 `JsonValue` 和 image resource 边界。
12. 所有 terminal path exactly once settle 外层 tool call；迟到的 worker message 和 method settlement 被忽略。
13. 旧 worker 确认退出前，不为同一 thread 启动 replacement writer。
14. plugin method namespace 不能覆盖或改变任何 Pi built-in tool；二者不在同一 registry。

## 6. 术语

### 6.1 Plugin method

插件 entry module 通过 `export const desktopPlugin` 声明的非模型方法。Desktop wrapper 直接读取该命名导出；方法不经过 `pi` 参数或任何 Pi registration API。它接收一个结构化 object 参数，返回一个符合 schema 的 JSON value，并可通过 execution context 贡献附件或进度。

### 6.2 Canonical plugin ID

registry 和动态 API 使用的 Desktop-approved ID：

- Marketplace：`ResolvedExtensionEntry.id`，例如 `com.acme.browser`；
- manifest-backed Development override：`ResolvedExtensionEntry.pluginId`；
- curated/builtin：静态 Desktop definition 的 `id`；
- 没有 manifest plugin ID 的 loose development file：没有 canonical plugin ID，不允许注册 plugin methods。

Development override 与被覆盖 Marketplace 插件共享 canonical plugin ID，但同一 generation 只能 admission 其中一个。

### 6.3 Plugin skill

由 approved plugin manifest 明确列出的 Pi skill。skill 是 API 和工作流的知识入口，不参与 runtime dispatch。

### 6.4 Plugin API catalog

插件制品中机器生成的 `plugin-api.json`。它包含声明的方法及 schemas，用于 sidecar 加载时检查文档制品与 module declaration 是否漂移，但不进入模型上下文。

### 6.5 Outer run

一次模型对 `plugin_call` 的调用及其 fresh code worker。

### 6.6 Sub-call

outer run 内一次 `plugin.<pluginId>.<method>(args)` 调用。sub-call 不成为 Pi tool call，只进入 bounded execution details 和 audit sink。

## 7. 模型暴露面

### 7.1 固定 tool schema

`plugin_call` 由 Desktop 自有 inline extension factory 使用现有 `pi.registerTool()` 注册。该 factory 使用固定 internal identity，例如 `<inline:desktop-plugin-call>`。`controlledResourceLoaderOptions()` 只在 approved resolved set 中至少有一个带非空、已预解析 catalog 的 method-based 插件时加入该 factory。Desktop 不声称能从 Pi 的 `getExtensions()` 结果反推出任意 tool 的 factory owner，也不修改 Pi 建立这种 attribution；普通 extension 若注册同名 tool，交由现有 Pi loader duplicate-tool/load error 处理，Desktop 将该 error 作为 blocking startup diagnostic。若后续 module declaration、default extension factory、catalog 或 skill validation 失败，Desktop 在 `createAgentSessionFromServices()` 和任何 provider request 之前终止 session startup；不存在 Desktop 自己完成 registry 后仍让未就绪 tool 对模型可见的状态。

固定 schema 如下：

```ts
const PluginCallParameters = Type.Object(
  {
    code: Type.String({
      description:
        "The body of an async TypeScript function. Top-level await and return are available.",
      maxLength: 262_144,
    }),
    description: Type.String({
      description: "A clear 5-10 word summary shown in the UI.",
      minLength: 1,
      maxLength: 160,
    }),
  },
  { additionalProperties: false },
);
```

工具定义语义：

```ts
{
  name: "plugin_call",
  label: "Plugin call",
  description:
    "Execute an erasable TypeScript program using enabled Desktop plugin APIs. " +
    "Read the relevant plugin skill before use. Return only the final value needed by the model.",
  parameters: PluginCallParameters,
  executionMode: "parallel",
}
```

`plugin_call` description 不列出插件、method、参数或 result schema。Pi 的普通 tool argument validation 继续校验 `code` 和 `description`。

### 7.2 Tool list

启用本功能后的模型 tool list 是：

```text
existing Pi built-in tools
+ ordinary model-facing extension tools registered with registerTool()
+ plugin_call (only when at least one plugin method is admitted)
```

`registerTool()` 与 Desktop `desktopPlugin.methods` declaration 是不同契约。前者表示作者明确需要模型直接调用的 Pi tool，仍按现有 Pi 行为暴露；后者由 Desktop wrapper 读取，永远不会单独出现在 Pi tool list。新 Desktop 插件 API 默认应使用 methods，只有无法通过 code gateway 表达的交互才使用 direct tool。

### 7.3 Progressive disclosure

Pi 现有 `formatSkillsForPrompt()` 继续只投影每个 skill 的 name、description 和 location。Desktop 不增加 method catalog、generated SDK declaration 或 method schema system section。

推荐流程：

```text
user task
  -> model sees plugin skill summary
  -> model reads the matching SKILL.md
  -> skill optionally points to references/api.md
  -> model writes one plugin_call program
  -> intermediate method values stay in the program
  -> outer return becomes the model-facing result
```

## 8. 插件打包与 skill admission

### 8.1 Marketplace manifest

`market-manifest.json` 的 `pi` 对象新增：

```json
{
  "pi": {
    "entry": "payload/index.js",
    "extensionApi": "1",
    "skills": ["payload/skills/plugin-browser/SKILL.md"],
    "pluginCall": {
      "skill": "plugin-browser",
      "catalog": "payload/plugin-api.json"
    }
  },
  "capabilities": ["plugin-methods.provide"]
}
```

规则：

1. `pi.skills` 可省略；存在时是无重复、非空的相对路径数组。
2. Marketplace skill/catalog path 必须以 `payload/` 开头并存在于 archive file table。
3. 每个 skill path 必须指向名为 `SKILL.md` 的 regular non-symlink file；catalog 必须是 regular non-symlink JSON file；canonical paths 必须位于 immutable version root 内。
4. `pi.pluginCall.skill` 是 method-based 插件的 primary skill name；它必须与一个 admitted `SKILL.md` frontmatter `name` 精确相等。
5. `pi.pluginCall.catalog` 指向机器生成 catalog。声明 `plugin-methods.provide` 时，`skills`、`pluginCall.skill` 和 `pluginCall.catalog` 必填。
6. 未声明 `plugin-methods.provide` 但 module 导出 `desktopPlugin`，或已声明 capability 但缺少有效 named export 时，Desktop startup admission 失败。
7. manifest parser 校验并解析 bounded catalog，返回 canonical skill/catalog paths、catalog digest、parsed catalog 和 primary skill name；installed registry 持久化 path/digest，main source policy 从 immutable path 重新读取并核对 digest后才写入 `ResolvedExtensionEntry`。thread sidecar 不重新信任未解析的相对路径或任意 catalog bytes。
8. artifact 的现有全信任模型不因这些文件改变；路径校验是版本一致性和运行稳定性要求。

### 8.2 `plugin-api.json`

```ts
interface PluginApiCatalogV1 {
  schemaVersion: 1;
  pluginId: string;
  methods: Array<{
    name: string;
    description: string;
    parameters: JsonObject;
    result: JsonObject;
    concurrency: "serial" | "parallel";
  }>;
}
```

catalog 由 plugin packaging command 从同一 declaration source 生成，methods 按 name 排序。Desktop registry builder 使用共享 schema profile 和 canonicalizer 后与 catalog exact compare。plugin ID、method set、description、schemas 或 concurrency 任一不一致，都使该插件 methods 和 skills 一起 admission 失败。

Plugin method schema 是 closed profile，不接受任意 TypeBox runtime feature：

- 允许 `Object`、`Array`、`Tuple`、`String`、`Number`、`Integer`、`Boolean`、`Null`、`Literal`、`Union` 和 `Optional`；
- object property key 必须是普通字符串，parameters root 必须 `additionalProperties: false`；
- 禁止 `$ref`、`$id`、recursive/self reference、`Transform`、`Unsafe`、custom kind、symbol metadata、default/coercion 和 executable validator；
- 允许的 string formats 固定为 `uri`、`date-time`、`email`、`uuid`、`hostname`、`ipv4`、`ipv6`，由 packaging/runtime 共用 format registry；其他 format registration 不参与 methods；
- schema 自身必须是最大 64 层、256 KiB 的 lossless JSON object；
- `canonicalizePluginSchema()` 保留 array order，并严格使用 RFC 8785 JSON Canonicalization Scheme 的 UTF-16 code-unit property ordering 和 number/string serialization 输出 UTF-8 bytes；不另加 Unicode code-point 排序；
- packaging 和 runtime 必须调用同一 `validatePluginSchemaProfile()`、`canonicalizePluginSchema()` 和 `compilePluginSchema()` 实现，catalog equality 比较 canonical bytes，不比较对象 identity。

runtime validation 只检查，不填 default、不 coerce、不删除 unknown fields。

catalog 不代表授权，不发送给 provider，也不要求模型读取。`SKILL.md` 的解释性 prose 无法完全机器验证；生成的 `references/api.md` 应来自同一 catalog，Marketplace verifier 至少检查 primary skill 引用了该 generated reference。

### 8.3 Development plugin

目录型 Development plugin 使用相同 manifest 字段。所有 entry、skill 和 catalog path 相对用户选择的 plugin directory 解析，并执行 containment、regular-file 和 symlink 检查。

单文件 loose development extension 没有稳定 plugin root、canonical plugin ID 或 skill admission，因此首期不能注册 plugin methods；它仍可使用普通 Pi extension API。

### 8.4 Curated 和 builtin plugin

`DesktopExtensionDefinition` 增加可选的 `skillPaths`、`pluginCallSkill`、`pluginCallCatalogPath` 和 `pluginCallCatalogSha256`。curated resources 必须位于 `curatedRoot`；builtin resources 必须是随 Desktop sidecar 打包的静态路径。main source policy 读取 path、核对或生成 digest，并产出与 Marketplace 相同的 parsed `pluginCallCatalog`。两者仍经过相同的 catalog、frontmatter 和 name collision 校验。

不是所有 inline factory 都是 plugin namespace。Desktop provider 等没有 plugin-call metadata 的 builtin inline extension 不得贡献 methods。

### 8.5 Resolved contracts

```ts
interface ResolvedExtensionEntry {
  // existing fields
  skillPaths?: string[];
  pluginCallSkill?: string;
  pluginCallCatalogPath?: string;
  pluginCallCatalogSha256?: string;
  pluginCallCatalog?: PluginApiCatalogV1;
}

interface InstalledMarketplacePluginRecord {
  // existing fields
  skillPaths?: string[];
  pluginCallSkill?: string;
  pluginCallCatalogPath?: string;
  pluginCallCatalogSha256?: string;
}
```

这些 paths 必须已经 canonicalize，catalog 必须是 main 按第 8.2 节解析的 bounded detached JSON，digest 是原始 catalog file 的 SHA-256。clone、fingerprint、registry persistence、ownership marker、generation comparison 和 sidecar binding 都必须包含相应字段；fingerprint 至少包含 digest，不拼接整个 catalog。更新插件版本后，运行中的旧 worker 继续引用旧 version root 中的 entry、catalog 和 skill；garbage collector 必须把 active worker generation 的所有 paths 一起视为版本引用。

### 8.6 Desktop-owned atomic admission

不修改 `DefaultResourceLoader`，也不增加 post-resource hook。Desktop 利用现有 `extensionFactories` 和 `additionalSkillPaths` 完成 admission：

1. main 解析并批准 entry、canonical plugin ID、`plugin-methods.provide` capability、skill/catalog paths、parsed catalog 和 primary skill name；catalog 必须至少声明一个 method；
2. `SessionRuntime.create()` 创建 generation-local `DesktopPluginRegistryBuilder`，并把它传给 `controlledResourceLoaderOptions()`；
3. 对每个 path-backed entry，Desktop 继续生成当前已有的 identity-bound inline wrapper；wrapper 用 `jiti` 导入完整 module namespace，而不是只取 default export；
4. wrapper 从 namespace 读取 own `desktopPlugin` named export，按第 9 节校验并放入 entry-local staging；它随后调用可选的 default Pi extension factory；只有 default factory 成功返回后才把 staged methods commit 到 builder；import、declaration 或 factory 任一失败都不 commit；
5. `ResourceLoader` 按现有行为加载普通 skills、Desktop builtin skills 和 `additionalSkillPaths` 中 main 批准的 plugin skill paths；Pi 的实现和顺序不变；
6. `createAgentSessionServices()` 返回后，Desktop 检查 extension diagnostics、保留 tool name ownership、builder declarations、catalog exact equality，以及 exact canonical `Skill.filePath` 对应的 primary skill；
7. 所有检查成功后 builder freeze 为 immutable registry；Desktop `plugin_call` inline factory 注册的 tool closure 此后才可执行；
8. 任一 plugin admission 失败都成为 blocking Desktop startup diagnostic，并在 `createAgentSessionFromServices()` 之前终止 live session startup。因此不会构建可向 provider 发请求的 `AgentSession`，也不需要从 Pi 已加载的 skill/tool arrays 中原地删除资源；
9. metadata/draft worker 执行相同 import、declaration、catalog 和 skill validation，但不注入 executable `plugin_call` factory，验证后丢弃 registry。

`SessionRuntime.create()` 的顺序必须可直接实现为：先创建 holder/builder；用它构造 `controlledResourceLoaderOptions()`；await `createAgentSessionServices()` 完成 extension/resource loading；执行 Desktop finalization；把 frozen registry bind 到 holder exactly once；最后调用现有的 `createAgentSessionFromServices()`。Pi services 对象在此阶段已完成 loader work，但尚未创建 `AgentSession`；finalization 失败时先 `builder.discard()`，dispose 已创建的 services resources，再抛出 `DesktopExtensionStartupError`。不得先创建 AgentSession 再补 registry。

`controlledResourceLoaderOptions()` 只在 resolved set 至少包含一个已批准、catalog 非空的 method-based plugin 时加入 Desktop `plugin_call` inline factory。该 factory 只调用现有 `pi.registerTool()` 一次，tool 的 `execute` closure 捕获 generation-local registry holder；holder 未 freeze、startup 已失败或 generation stale 时拒绝执行。因为 AgentSession 在 holder freeze 后才创建，正常 provider 路径永远看不到未就绪 tool。

`controlledResourceLoaderOptions()` 只在 resolved set 至少包含一个已批准、catalog 非空的 method-based plugin 时加入 Desktop `plugin_call` inline factory。该 factory 只调用现有 `pi.registerTool()` 一次，tool 的 `execute` closure 捕获 generation-local registry holder；holder 未 freeze、startup 已失败或 generation stale 时拒绝执行。因为 AgentSession 在 holder freeze 后才创建，正常 provider 路径永远看不到未就绪 tool。

plugin primary skill 必须满足：frontmatter 显式包含合法 `name` 和非空 `description`；name/description 通过 Pi Agent Skills validation；`disable-model-invocation` 必须不存在或为 `false`；loaded `filePath` 等于 approved canonical path；name 未与任何 earlier ordinary/plugin skill 冲突；该 path 没有任何 read/frontmatter/name/description diagnostic。对 plugin-owned primary skill，Desktop 把 Pi 原本 lenient 的这些 warnings 提升为 blocking startup error；unknown frontmatter fields 和非 primary supplemental skill warnings仍沿用 Pi 行为。

不能启动只有 skill 没有 registry、或只有 registry 没有 model-visible primary skill 的 live session。普通 global/project/builtin skills 和 `skillsOverride` 的既有结果不被 Desktop 修改；冲突时整个新 generation 启动失败，旧 live generation 按 replacement rollback 规则继续运行。

### 8.7 SKILL.md 内容要求

primary `SKILL.md` 至少包含：

- 何时使用和何时不使用该插件；
- canonical plugin ID 和准确调用语法；
- 每个公开 method 的参数和结果 TypeScript shape；
- required/optional 字段、默认值、上限和枚举；
- 副作用、幂等性、并发约束和可能的用户交互；
- stable error codes 及可恢复方式；
- 最小调用示例和推荐的多步工作流；
- 大型 API 时指向 generated `references/api.md`，不要把全部参考内容放入 skill description。

skill frontmatter description 应说明任务领域，不应枚举 methods。建议 skill name 为 `plugin-<short-name>`，并在所有已启用 skills 中保持唯一。

## 9. Desktop module declaration contract

### 9.1 类型

插件 entry module 可以使用 plugin-create 生成的本地 type helper；runtime 只依赖以下结构，不要求安装或导入新的 Pi package：

```ts
import type { Static, TSchema } from "typebox";

export interface DesktopPluginMethodDefinition<
  TParams extends TSchema = TSchema,
  TResult extends TSchema = TSchema,
> {
  name: string;
  description: string;
  parameters: TParams;
  result: TResult;
  concurrency?: "serial" | "parallel";
  execute(
    params: Static<TParams>,
    signal: AbortSignal,
    ctx: PluginMethodExecutionContext,
  ): Promise<Static<TResult>>;
}

export interface DesktopPluginModuleExport {
  schemaVersion: 1;
  methods: readonly DesktopPluginMethodDefinition[];
}

export interface PluginMethodExecutionContext {
  readonly pluginId: string;
  readonly methodName: string;
  readonly callId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  attach(attachment: PluginMethodAttachment): void;
  reportProgress(progress: JsonValue): void;
}

export type PluginMethodAttachment =
  | { type: "image"; data: string; mimeType: string; name?: string }
  | { type: "file"; path: string; mimeType?: string; name?: string };
```

`signal` 同时作为第二个参数和 `ctx.signal` 提供；两者必须是同一个对象。`DesktopPluginModuleExport` 的 helper/type definitions 属于 Desktop plugin-create 模板和 Desktop 文档，不加入 `@earendil-works/pi-coding-agent`。

### 9.2 示例

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopPluginModuleExport } from "./desktop-plugin-types.ts";

export const desktopPlugin = {
  schemaVersion: 1,
  methods: [
    {
      name: "get",
      description: "Fetch a web page and return extracted content",
      parameters: Type.Object(
        { url: Type.String({ format: "uri" }) },
        { additionalProperties: false },
      ),
      result: Type.Object(
        {
          title: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute(params, signal) {
        return fetchPage(params.url, signal);
      },
    },
  ],
} satisfies DesktopPluginModuleExport;

export default function setupPiExtension(pi: ExtensionAPI) {
  // Optional: ordinary Pi tools/events/commands remain registered through Pi.
}
```

Method-only plugins may omit the default export. Existing Pi extensions without `desktopPlugin` continue to require their current valid default factory and behave unchanged.

### 9.3 Declaration rules

1. `desktopPlugin` 必须是 module namespace 的 own named export，不能从 default factory 动态创建或后续替换。
2. plugin ID 不出现在 declaration 中，由 Desktop wrapper 当前绑定的 approved `ResolvedExtensionEntry.id` 注入。
3. `schemaVersion` 首期必须等于 `1`，`methods` 必须是非空 array。
4. wrapper 只接受 plain object/array 的 own data properties；accessor descriptor、class instance、symbol key、descriptor inspection failure 和非预期字段被拒绝。透明 Proxy 不能被 JavaScript 可靠识别，本规范不声称以此形成安全边界；任何 trap throw 或不稳定 descriptor/value 读取都使 admission 失败。
5. `parameters` 首期必须是本规范 schema profile 的 object schema。无参数 method 使用 `Type.Object({}, { additionalProperties: false })` 并以 `{}` 调用。
6. `result` 可以使用 closed schema profile 的任意 JSON-compatible root，但推荐 object schema。
7. `name` 必须匹配 `^[a-z][A-Za-z0-9_]*$`，最大 64 字符，并拒绝 `then`、`constructor`、`prototype` 和 `__proto__`。
8. `description` 最大 500 字符，不自动进入模型 prompt。
9. 同一 plugin ID 下重复 name 使该 generation admission 失败。
10. wrapper 在 staging 时以 descriptor-safe traversal snapshot schemas/metadata、编译 validators 并捕获 `execute` function；插件后续 mutate 原 export object 不改变 registry。
11. `concurrency` 默认 `serial`。`parallel` 表示作者确认同一插件的多个调用可以并发。
12. handler throw 表示 method failure；result 必须先 schema check，再 detached JSON snapshot。
13. `desktopPlugin` 存在但 capability/catalog metadata 缺失时 startup 失败；capability 已声明但 named export 缺失或为空时同样失败。
14. method declaration 是静态 module contract。事件回调、timeout 或 default factory 中不能动态增删 methods。

### 9.4 Desktop wrapper ownership

所有 method discovery 和 attribution 都在 `packages/desktop/src/main/pi/desktop-extension-runtime-policy.ts` 的 per-entry wrapper 内完成：

```ts
interface DesktopPluginRegistryBuilder {
  stage(entry: ResolvedExtensionEntry, declaration: unknown): StagedDesktopPlugin;
  commit(staged: StagedDesktopPlugin): void;
  finalize(skills: Skill[]): PluginMethodRegistry;
  discard(): void;
}
```

wrapper 已闭包绑定 exact approved entry，因此不使用 async caller inference、可变全局 `currentPluginId`、`AsyncLocalStorage` 或插件自报 ID。概念顺序固定为：import namespace；stage named export；运行可选 default factory；成功后 commit。Pi 只执行这个普通 inline wrapper，既不知道 named export，也不保存 methods。

builtin method-based plugin 不经过 path import，但必须由 Desktop builtin definition 直接携带 declaration，并走同一个 `stage/commit/finalize` validator。普通 Desktop provider inline factory没有 declaration，不进入 registry。

这条边界是强制约束：不得以“实现更方便”为由向 Pi `ExtensionAPI`、loader result、runner 或 ResourceLoader 增加 hidden method state。

## 10. Session-scoped registry

### 10.1 结构

```ts
interface RegisteredDesktopPluginMethod {
  pluginId: string;
  primarySkill: string;
  entryId: string;
  source: DesktopExtensionSource;
  version?: string;
  name: string;
  description: string;
  concurrency: "serial" | "parallel";
  execute: DesktopPluginMethodDefinition["execute"];
  validateParameters(value: unknown): JsonObject;
  validateResult(value: unknown): JsonValue;
}

type PluginMethodRegistry = ReadonlyMap<
  string,
  ReadonlyMap<string, RegisteredDesktopPluginMethod>
>;
```

registry owner 是 `SessionRuntime`，生命周期等于一个 thread worker generation。它不放入 Electron main singleton，不跨 thread 共享，也不持久化到 session JSONL。

### 10.2 Build order

registry 按 `ResolvedExtensionSet.entries` 的 approved order 构建，但 plugin/method identity 不使用 first-wins。任何重复 canonical plugin ID 或 method 都产生 blocking diagnostic。只有所有 module declaration、default factory、catalog 和 primary skill checks 成功后，registry 才 freeze 并交给 `plugin_call`。

### 10.3 Identity syntax

Marketplace ID 允许点和连字符，例如 `com.acme.web-tools`。动态 API 支持两种等价访问：

```ts
await plugin.com.acme["web-tools"].get({ url });
await plugin["com.acme.web-tools"].get({ url });
```

当 canonical ID 本身是 `browser` 时，可以写：

```ts
await plugin.browser.get({ url });
```

bracket form 是所有合法 ID 的无歧义 canonical syntax，plugin skill 必须至少展示一次。运行时用 null-prototype objects 和 own-property lookup 构建 namespace，不沿原型链解析。点分层级与完整 bracket key 指向同一个 frozen plugin namespace。

## 11. `plugin_call` code runtime

### 11.1 Topology

```text
model tool call
  -> Pi agent loop validates plugin_call args and runs outer tool hooks
  -> thread sidecar PluginCallTool.execute()
  -> fresh node:worker_threads Worker
       -> strip erasable TypeScript
       -> execute as strict async function body
       -> plugin namespace sends sub-call messages
  -> sidecar PluginMethodDispatcher
       -> validate args
       -> invoke extension handler in thread sidecar
       -> validate result
       -> send detached JSON response to code worker
  -> validate and render outer return
  -> one AgentToolResult
```

插件 handler 继续在拥有 extension instance 的 thread sidecar isolate 中运行。生成程序运行在每次 outer run 新建的 worker thread 中；extension closure 不复制、不序列化到 code worker。

### 11.2 与 Pi tool pipeline 的关系

外层 `plugin_call` 是普通 `ToolDefinition`，完整经过 Pi 现有 argument preparation/schema validation、`tool_call` hooks、execution events、`tool_result` hooks、result normalization 和 transcript persistence。

内部 plugin method 不是 `ToolDefinition`，故意不经过以下 Pi tool-only 语义：

- `prepareArguments`；
- `tool_call` argument mutation/block hooks；
- `tool_result` content/details replacement hooks；
- active-tool changes 和 `addedToolNames`；
- method-specific `usage`、`terminate`；
- 独立 Pi `tool_execution_*` events 和 toolResult message。

原因是 provider transcript 中不存在对应的 nested tool call；伪造这些事件会造成 unmatched tool lifecycle。method dispatcher 必须独立实现本规范要求的 validation、source attribution、cancellation、concurrency、progress、attachments 和 audit，不复制 Pi tool wrapper 并声称两者语义相同。

需要 cross-cutting policy 的扩展应拦截外层 `plugin_call`，或未来使用专门的 `plugin_method_call/result` hook；首期不新增该 hook。插件方法本身的权限继续由 Desktop approved plugin 和全信任模型决定。

### 11.3 TypeScript execution contract

`code` 是 async function body，不是完整 module：

- 顶层 `await` 和 `return` 可用；
- 使用 Node `stripTypeScriptTypes()` 的 strip-only、erasable TypeScript；
- type annotation、interface 和 type alias 可用；
- `enum`、namespace、parameter property、decorator 及其他需要 JS emit 的语法失败；
- 静态 `import` / `export` 在 function body 中非法；需要 Node API时使用 `await import("node:...")`；
- program 在 strict mode 下运行；
- 每次调用是 fresh global state，不保证跨 outer run 保存变量或 module-local state。

### 11.4 Authority model

code worker 继承 thread sidecar 的用户权限、环境、网络、文件系统和 Node module 能力。它可以动态 import Node builtins、访问环境变量并通过受支持的 child-process wrapper 启动子进程。worker thread 是可终止的 execution substrate，不是安全 sandbox。

因此：

- skill、capability 和 method registry 是发现与 API routing 机制，不是权限边界；
- 生成代码理论上可以绕过 `plugin` API 直接访问系统；
- heap/time/output limits 是防止常见失控的运行稳定性措施，不能约束故意绕过；
- native module 可以影响整个 sidecar；
- worker bootstrap 在生成程序运行前通过 `createRequire()` patch CJS `node:child_process` exports，并调用 `syncBuiltinESMExports()`，使 dynamic ESM imports 也得到 tracked `spawn`、`exec`、`execFile`、`fork` 及同步 variants；这些 wrappers 拒绝 `detached: true`，记录 PID/process group，并在 outer settlement 后执行 bounded TERM/KILL tree cleanup；
- bootstrap 同时拒绝生成代码创建 nested `worker_threads.Worker`、`cluster` worker 或其他不受 outer heap/termination ownership 管理的 execution isolate；
- code worker 退出前 host 必须完成其 tracked descendants cleanup，thread sidecar dispose 仍对剩余进程树做最终清理；
- 拥有完整 Node authority 的代码可以故意恢复原始 binding、通过 native module 或 shell daemonization 绕过 wrapper；这是第 2 节明确 supersede 的 no-orphan 例外，不能描述为已隔离。

### 11.5 Worker bootstrap

host 在 spawn 前用与真实 async function body 相同的 wrapper 执行 type stripping，保留 body line positions。boot data 只包含：

- stripped code；
- admitted plugin ID 和 method name tree；
- output/attachment limits；
- dedicated message port；
- outer run correlation metadata。

schema、handler、plugin configuration、secret 和 method result 不进入 boot data。worker 通过 async function constructor 注入 `plugin` 和 bounded `console`。namespace member 始终是 async function。

worker 发送的所有消息即使来自本机代码也按 untrusted wire data 校验：检查 message type、run token、integer call ID、plugin ID、method、JSON payload、深度、size 和 state transition；malformed、duplicate 或 terminal 后 message 被丢弃并记录 bounded diagnostic，不能让 message listener throw 导致 sidecar crash。

由于生成代码拥有完整 Node authority，它可以访问 worker primitives 并故意伪造消息；wire validation 只防止 accidental corruption，不构成对恶意代码的安全保证。

## 12. Internal bridge protocol

### 12.1 Worker to host

```ts
type PluginWorkerMessage =
  | {
      type: "call";
      runId: string;
      id: number;
      pluginId: string;
      method: string;
      args: JsonValue;
    }
  | { type: "log"; runId: string; sequence: number; level: PluginLogLevel; text: string }
  | { type: "done"; runId: string; value?: JsonValue }
  | {
      type: "failed";
      runId: string;
      kind: "syntax" | "exception" | "invalid-output" | "output-limit";
      message: string;
    };
```

### 12.2 Host to worker

```ts
type PluginHostMessage =
  | { type: "resolve"; runId: string; id: number; value: JsonValue }
  | {
      type: "reject";
      runId: string;
      id: number;
      error: PluginMethodErrorWire;
    }
  | { type: "abort"; runId: string; reason: string };
```

`id` 在一个 outer run 内从 1 单调递增。host 对每个 ID 最多回复一次。worker 对未知或重复 reply 忽略。bridge 不把 Error object、stack、class instance、Buffer 或 typed array 直接 structured-clone；所有 payload 先变为明确的 JSON wire shape。

### 12.3 Dynamic dispatch

调用步骤：

1. worker 对 args 做 lossless JSON snapshot；
2. host exact lookup canonical plugin ID 和 method name；
3. host 检查调用预算和 abort state；
4. host 使用预编译 validator 校验 args；
5. dispatcher 获取 plugin serial lane 或 global parallel slot；
6. 创建 sub-call `AbortController` 和 execution context；
7. 调用 handler；
8. 校验 result schema 并做 detached JSON snapshot；
9. 原子提交该 sub-call 的 attachments，记录 audit settlement；
10. 若 outer run 仍 active，向 worker resolve/reject。

任何 method result 都不调用 Pi `sendMessage()`，不追加 session entry，也不触发嵌套 `tool_execution_*` event。

## 13. Concurrency

默认策略：

- 一个 outer run 最多 64 次 sub-call；
- 一个 outer run 最多 8 个 executing sub-calls；
- `concurrency: "serial"` 的 methods 在同一 plugin ID 的 FIFO lane 中互斥；
- 不同 plugin ID 的 serial lanes 可以并行；
- `concurrency: "parallel"` 可以在 global cap 内与同插件调用并行；
- queue wait 计入 outer wall timeout；
- outer run 结束后未开始的 queued calls 直接以 `PLUGIN_CALL_ABORTED` settle。

程序可以用 `Promise.all()` 表达并行。结果按各 Promise 正常 settlement 返回；audit records 使用 submission sequence 保持确定性展示，不以完成顺序重排代码语义。console/log records 使用独立 monotonic sequence 保留 host 收到的顺序。

同一 agent turn 中多个顶层 `plugin_call` 由 Pi 现有 tool execution scheduler 决定是否并行。每个 outer run 有独立 worker 和预算，但共享 session registry 的 plugin serial lanes，因而同一插件的默认 serial 约束跨 outer runs 生效。

Plugin serial lanes 不与 native Pi tool scheduler 合并，因为 methods 不属于 native tool registry。需要与某个 native tool 全局互斥的插件必须在自己的 handler 中使用共享资源锁；Desktop 不根据名称猜测互斥关系。

## 14. Cancellation、timeout 和 disposal

### 14.1 Abort propagation

每次 outer execution 无条件创建 host-owned `AbortController` 作为 root。若 Pi 提供 `signal`，host 用 once listener 把其 reason 转发到 root；若 Pi 的 optional signal 为 `undefined`，root 仍由 timeout、worker failure 和 `SessionRuntime.dispose()` 驱动。每个 method controller 监听这个 root，并把自己的 signal 作为 definition 第二参数和 `ctx.signal` 的同一对象。

```text
Pi tool signal abort（如存在）/ timeout / worker failure / runtime dispose
  -> abort host-owned root controller exactly once
  -> mark outer run terminal-pending
  -> stop admitting new sub-calls
  -> abort every queued/executing method controller with the same normalized reason
  -> reject pending worker calls
  -> terminate code worker
  -> clean tracked descendants
  -> wait for worker exit and cleanup
  -> settle plugin_call with the originating stable error code
```

Pi abort 使用 `PLUGIN_CALL_ABORTED`；wall/compute budget 使用 `PLUGIN_CALL_TIMEOUT`；worker failure 保留对应 code。worker parse failure、uncaught exception、output limit 或 unexpected exit 也必须通过 root abort 所有 sub-call controllers。outer settle 后移除 Pi signal listener。

### 14.2 Limits

首期 host-owned defaults：

| Limit | Default |
| --- | ---: |
| code UTF-8 bytes | 256 KiB |
| measured worker event-loop busy time | 30 s |
| outer wall time | 120 s |
| worker old-generation heap | 256 MiB |
| JSON nesting depth | 64 |
| sub-calls per outer run | 64 |
| concurrent sub-calls per outer run | 8 |
| one method result JSON | 16 MiB |
| cumulative method response JSON | 64 MiB |
| model-facing outer JSON | 1 MiB |
| captured UI-only logs | 256 KiB |
| one progress value | 64 KiB |
| cumulative accepted progress | 1 MiB |
| projected progress frequency | at most 10 updates/s, latest per sub-call wins |
| attachments | 20 |
| one file attachment | 256 MiB |
| cumulative file attachments | 512 MiB |
| cumulative image attachment data | 32 MiB decoded |

busy-time 通过 worker `performance.eventLoopUtilization()` 定期采样；等待 method response 不累计 compute budget，但始终累计 wall time。wall timer 必须低于 Node 最大 timer delay。

`reportProgress()` 先做与普通 JSON 相同的 depth/lossless validation。单值超限 throw `PLUGIN_PROGRESS_LIMIT_EXCEEDED`；cumulative limit 到达后拒绝后续 progress，但不取消已运行 handler。host 只保留每个 sub-call 最新值，以 100 ms trailing-edge coalescing 产生 outer `onUpdate()`，terminal transition 立即 flush；被覆盖的 progress 不持久化。

这些 limits 是 Desktop constants/configuration，不由插件或模型参数覆盖。实现可在性能测试后调整数值，但不能移除对应 limit 或改变 error taxonomy。

### 14.3 Cooperative handler limitation

extension handler 与 `SessionRuntime` 位于同一 sidecar isolate，不能像 code worker 一样单独 hard-kill。handler 必须观察 `AbortSignal`。当 handler 忽略 abort 时：

- outer tool 仍按 timeout/abort 结束；
- late result、progress、attachment 和 UI request 被 generation/run guard 丢弃；
- dispatcher 保留 rejection handler，避免 unhandled rejection；
- stuck synchronous handler 会阻塞整个 thread sidecar，这是全信任 extension 模型的已知限制；
- 需要强隔离时必须采用未来的 per-plugin process，不在本规范首期范围。

已经完成的 method side effects 不回滚。outer failure text 可以报告 completed/failed sub-call count，但不能声称事务回滚。

### 14.4 Generation disposal

`SessionRuntime.dispose()` 必须：

1. 标记 registry stale，拒绝新 calls；
2. abort all outer runs 和 method contexts；
3. terminate并 await 所有 code workers；
4. 对 cooperative handlers 等待一个 bounded drain deadline；
5. 清空 queues、attachments 和 audit buffers；
6. 再完成 extension/session shutdown。

任何旧 generation completion 都不能 publish 到 replacement worker 的 timeline。不能把旧 worker 发起的 call 静默路由到新版本 registry。

## 15. Output contract

### 15.1 Method values

method result 返回 worker 后只是普通 JSON value：

```ts
const page = await plugin.browser.get({ url });
const title = page.title;
```

它不会自动成为 outer tool output。程序必须显式 `return` 最终值。

### 15.2 Outer result

successful outer program 的 return value 必须是 lossless JSON 或 `undefined`。渲染规则：

- string：作为单个 text content 原样返回；
- 其他 JSON：稳定 two-space JSON text；
- `undefined`：返回 `(plugin_call completed with no output)`；
- image attachments：在 text content 后追加 Pi `ImageContent`；
UI-only logs、sub-call audit 和 private file records 使用以下 exact `details` contract，不加入 model text：

```ts
interface PluginCallDetails {
  kind: "plugin-call-details-v1";
  description: string;
  runId: string;
  generation: string;
  logs: Array<{ sequence: number; level: PluginLogLevel; text: string }>;
  calls: PluginSubCallRecord[];
  attachments: Array<
    | { type: "image"; contentIndex: number; name?: string }
    | {
        type: "file";
        artifactId: string;
        canonicalPath: string;
        name: string;
        mimeType?: string;
        size: number;
        sha256: string;
      }
  >;
  truncation?: { logs?: true; calls?: true; attachments?: true };
}
```

`canonicalPath` 和 `sha256` 只存在于 sidecar-private details 和本地 JSONL。第 21 节 projector allowlist 必须把它转换为不含 path/hash 的 `PiPluginCallArtifact`；任何通用 JsonValue projector 都不得透传该 details object。

外层 JSON 在 stringify 前再次 schema-independent lossless snapshot，并按 UTF-8 JSON byte size 限制。超限是 explicit failure，不能静默截断成看似有效的 JSON。

### 15.3 Console

worker 注入只含 `log`、`info`、`warn`、`error`、`debug` 的 bounded console shim。console 输出用于 Desktop 展开详情和 diagnostics，不进入 LLM tool result content。不要把 host process 的原始 console object 直接传给生成代码。

## 16. Attachments

### 16.1 Collection

plugin handler 使用 `ctx.attach()`，附件不混入 JSON result。这样 code 可以继续处理纯 JSON，而 outer `plugin_call` 聚合调用链产生的 media。

每次 `attach()` 必须同步完成 shape、MIME、path、当前 regular-file stat 和声明 size budget admission；失败立即 throw，不到 handler 返回后再静默丢弃。附件先存入 sub-call-local staging。method result validation 成功后，dispatcher 异步完成 file hash/identity validation；全部成功才原子提交该 sub-call 的附件，否则 sub-call 以 attachment error 失败。failed/aborted sub-call 的附件全部丢弃。

### 16.2 Images

- `data` 是无 data-URL prefix 的 base64；
- MIME 必须是 Pi/provider 支持的 image MIME；
- host 校验 base64、decoded bytes 和 cumulative limit；
- admitted image 进入 final `AgentToolResult.content`，因此会作为 outer result 的附件进入模型上下文；
- Pi JSONL 按普通 toolResult image content 持久化 base64；
- projector 为每张图建立 `SessionImageResourceRef`，timeline 只保留 `resourceId` 和 MIME，body 继续通过 `sessions.readImageResource` 按需读取；
- `PiToolCallPart.pluginCall.attachments` 包含同一个 image ref，不复制 base64；
- outer run 失败或 abort 时不发布已收集 image。

### 16.3 Files

- relative path 按 session `cwd` 解析；absolute path 保留；
- `attach()` 同步 canonicalize、确认 regular file、记录 initial stat 并执行 file size budgets；method 成功后的 dispatcher commit phase 以 non-following file handle 异步流式计算 SHA-256，比较 handle 的 before/after stat 及 canonical path 当前 identity，任一 identity/size 变化都使 sub-call 以 attachment error 失败；
- Pi toolResult `details` 中的 sidecar-private record 保存 canonical path、display name、MIME、size、SHA-256 和 artifact ID；它进入本地 session JSONL，但 projector 必须剥离 canonical path/hash，不能把原始 details 直接投影；
- artifact ID 使用 host 生成并持久化的随机 UUID；同一 tool result 内必须唯一，不能编码或泄露 path、session ID 或 generation；
- timeline/renderer 只得到 artifact ID、name、MIME、size 和 safe display path；
- project root 内路径的 safe display path 是 project-relative path；project root 外一律只显示 basename，不显示 parent directories；`agentDir`、Desktop `userData` 和 Marketplace/curated install roots 中的文件不得 attach，返回 `PLUGIN_ATTACHMENT_PATH_PRIVATE`；
- file bytes 不进入 model context。模型若需要内容，程序应由插件返回摘要，或使用现有 Pi `read` tool；
- renderer 通过 `sessions.openPluginCallArtifact({ projectId, threadId, toolCallId, artifactId })` 请求打开；main 把 opaque IDs 发给 owning thread sidecar，sidecar 从当前/replayed private details exact resolve canonical path，重新检查 regular file/size 并流式重算 SHA-256；只有 size/hash 都相等才把 path 返回 main执行受信任 open；renderer 永不接收 canonical path/hash；
- replay 时 projector 从 persisted private details 重建 artifact lookup。文件已移动、删除、同路径替换、size/hash 不匹配时返回 `PLUGIN_ARTIFACT_UNAVAILABLE`，UI 显示 unavailable；
- outer run 失败或 abort 时不发布 file attachment。

## 17. Error contract

### 17.1 Stable codes

```ts
type PluginCallErrorCode =
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_METHOD_NOT_FOUND"
  | "PLUGIN_METHOD_INVALID_ARGUMENTS"
  | "PLUGIN_METHOD_EXECUTION_FAILED"
  | "PLUGIN_METHOD_INVALID_RESULT"
  | "PLUGIN_CALL_LIMIT_EXCEEDED"
  | "PLUGIN_RESPONSE_LIMIT_EXCEEDED"
  | "PLUGIN_PROGRESS_LIMIT_EXCEEDED"
  | "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED"
  | "PLUGIN_ATTACHMENT_PATH_PRIVATE"
  | "PLUGIN_ARTIFACT_UNAVAILABLE"
  | "PLUGIN_CODE_SYNTAX_ERROR"
  | "PLUGIN_CODE_EXCEPTION"
  | "PLUGIN_CODE_INVALID_OUTPUT"
  | "PLUGIN_CALL_TIMEOUT"
  | "PLUGIN_CALL_ABORTED"
  | "PLUGIN_CODE_WORKER_EXIT"
  | "PLUGIN_OUTPUT_LIMIT_EXCEEDED"
  | "PLUGIN_GENERATION_STALE";
```

worker 中 method rejection 使用真实 `PluginMethodError extends Error`，带 own enumerable `code`、`pluginId`、`method`；不依赖解析 message string。

### 17.2 Model-facing errors

错误文本必须简洁、稳定、可自我修正。例如：

```text
Unknown plugin method: plugin["com.acme.browser"].search
Read the plugin-browser skill for available methods.
```

参数错误最多返回 bounded schema diagnostics，包括 JSON pointer 和 expected constraint；不回显完整 secret-bearing args。plugin throw 的 stack、private install path、environment 和 configuration 不进入 model content 或 renderer；完整 stack 只进入本地受限 diagnostic sink，并仍需 redaction。

abort、timeout、worker exit、invalid result 和 plugin execution failure 是不同 code，不能全部折叠成 `PLUGIN_CODE_EXCEPTION`。

### 17.3 Outer tool status

任何 outer failure 通过现有 Pi tool throw path 形成 `isError=true` 的 tool result。它不把 assistant message本身改成 incomplete；`pi-native-assistant-ui-runtime-spec.md` 的 tool failure 投影规则保持不变。

## 18. Audit、progress 和 UI

### 18.1 Sub-call records

每个 sub-call 记录 bounded metadata：

```ts
interface PluginSubCallRecord {
  sequence: number;
  callId: string;
  pluginId: string;
  method: string;
  source: DesktopExtensionSource;
  version?: string;
  state: "queued" | "running" | "complete" | "error" | "aborted";
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  errorCode?: PluginCallErrorCode;
  progress?: JsonValue;
}
```

默认不把完整 params/results 放入 renderer details，防止重复大 payload 和 secret 泄露。开发诊断模式可以使用独立 redacted local audit sink，但不改变 session JSONL 或模型 context。

### 18.2 Pi lifecycle

外层仍只有：

```text
tool_execution_start(plugin_call)
tool_execution_update(plugin_call, PluginCallDetails summary)
tool_execution_end(plugin_call, AgentToolResult)
toolResult message fold
```

`reportProgress()` 和 sub-call transitions 可以节流合并为 outer `onUpdate()` details。partial update 不设置 terminal `result`，避免 assistant-ui 提前把 tool part 标记 complete。

### 18.3 Desktop renderer

`ToolView` 对 `plugin_call` 使用：

- label：`plugin`；
- target：模型提供的 `description`；
- collapsed row：running/complete/error 和 active/completed sub-call count；
- expanded body：logs、按 submission sequence 排列的 method waterfall、stable errors 和附件；
- 不在 collapsed title 展示 raw code；
- code、args 和 outer result 仍可在 expanded technical details 中查看，并遵守现有截断规则。

renderer 只展示 backend execution，不注册或执行 frontend tool implementation。首期 nested methods 使用 generic JSON/progress renderer；现有 browser、memory、subagent 等 specialized cards 继续只处理 native top-level tools，不按 method name 猜测复用。

### 18.4 Persistence

outer `plugin_call` 的 args、final result 和 bounded details 随普通 Pi toolResult 持久化。sub-call records 不是独立 timeline nodes，也没有独立 provider messages。重连/resync 从同一个 outer tool part 重建详情。

## 19. Capability model

`DesktopExtensionCapability` 新增纯 Desktop capability：

```ts
type DesktopExtensionCapability =
  | /* existing */
  | "plugin-methods.provide";
```

Desktop per-entry wrapper 必须 gate module declaration：

- exact approved entry 同时具有 canonical plugin ID、primary skill、parsed catalog 和 capability：允许 stage declaration；
- module 导出 `desktopPlugin` 但 capability 或 plugin-call metadata 任一缺失：blocking `DESKTOP_PLUGIN_DECLARATION_UNAUTHORIZED`；
- capability 存在但 named export 缺失、无效或与 catalog 漂移：blocking `DESKTOP_PLUGIN_DECLARATION_INVALID`；
- optional default Pi factory failure：丢弃该 entry 的 staged methods，并沿用现有 Pi extension load diagnostic；
- method execution 不逐次向 main/renderer 请求授权；
- capability 只表示制品提供可由模型生成程序调用的方法，不表示 OS 权限限制。

这里不依赖 Pi shared Host UI context 的 caller attribution。Desktop wrapper 本身由 `ResolvedExtensionEntry` 创建并闭包绑定 identity，在调用 default Pi factory 前直接读取 module namespace。因此 Host Profile 中“共享 Pi host 无 per-caller isolation”的限制保持不变，也无需修改 Pi 来解决 method attribution。

普通 direct `registerTool()` 的 manifest 继续声明 `tools.register`；本规范不新增其 per-caller enforcement。两个 capability 可以同时声明，但 Marketplace UI 应分别显示“直接模型工具”和“程序化插件方法”，避免用户误认为 methods 不可执行系统操作。

## 20. Session、draft、reload 和 persistence

### 20.1 New/open session

thread worker bootstrap 中的 `ResolvedExtensionSet` 决定 methods、catalog 和 skills。open existing session 时使用当前批准 generation 和该 session 的 `enabledPluginIds` 选择结果；session JSONL 不保存 method definitions 或 schemas。

new-session draft 和 live thread 必须从同一 main-owned source policy 解析 plugin metadata。metadata worker 可以验证/display manifests 和 skill summaries，但不创建 executable method registry，不暴露 `plugin_call`，也不运行模型代码。

### 20.2 Reload

插件启用状态、版本、配置、entry、skill、catalog 或 capability 变化都会改变 extension-set fingerprint，并通过现有 replacement worker 生效。不能在当前 registry 中 mutate。

资源-only reload 如果可能改变 plugin skill，也必须走 generation replacement；不能让同一 live registry 配上新 API 文档。

### 20.3 Replay

历史 `plugin_call` 作为普通 Pi tool call/result replay。重放只显示持久化的 outer args/result 和 bounded details，不重新执行 code，不要求当前仍安装相同插件，也不从当前 registry 反推历史 method metadata。

### 20.4 Child/subagent policy

首期 `plugin_call` 只注册在 Desktop live thread `SessionRuntime`。metadata workers、subagent workers和 standalone Pi CLI 不继承 parent registry。skill 可以按现有 subagent skill policy作为知识传入，但没有 matching `plugin_call` 时必须明确视为不可执行；默认不向 subagent 注入 plugin skills，避免广告不可用 API。

未来若 subagent 需要插件能力，必须把 approved extension generation、registry ownership、worker lifecycle 和 audit 回传作为独立设计，不能通过访问 parent thread singleton 绕过 single-writer/generation 边界。

## 21. Sidecar 和 renderer protocol

code worker bridge 是 thread sidecar 内部协议，不加入 Electron main wire。

本规范固定扩展 `PiToolCallPart`，不再把 attachment transport 留给实现判断：

```ts
interface PiToolCallPart {
  // existing fields
  pluginCall?: PiPluginCallArtifact;
}

interface PiPluginCallArtifact {
  kind: "plugin-call";
  description: string;
  generation: string;
  calls: PluginSubCallRecord[];
  logs: Array<{ sequence: number; level: PluginLogLevel; text: string }>;
  attachments: Array<
    | ({ type: "image"; name?: string } & SessionImageResourceRef)
    | {
        type: "file";
        artifactId: string;
        name: string;
        mimeType?: string;
        size: number;
        displayPath: string;
      }
  >;
  truncation?: { logs?: true; calls?: true; attachments?: true };
}
```

`pluginCall` 是 projector 从 persisted `AgentToolResult.details` 和 image content 生成的 allowlisted renderer DTO。bootstrap 和 live `tool-call-replaced` 必须调用同一个 pure converter。partial execution 时它进入 assistant-ui 的 UI-only `artifact`；terminal 时仍保留在 `artifact`，而正式 `result` 继续是现有 outer `AgentToolResult` projection。renderer 不得从 `result.details` 自行解析 private records。

新增 Desktop request：

```ts
interface OpenPluginCallArtifactInput {
  projectId: string;
  threadId: string;
  toolCallId: string;
  artifactId: string;
}
```

main 只接受当前 attachment lease 对应 thread 的请求，并向 owning thread worker 发 `resolvePluginCallArtifact` command；sidecar 返回 canonical path 给 main，不返回 renderer。该 command 和 result 改变 main/sidecar wire，因此 bump `SIDECAR_PROTOCOL_VERSION`；`PiToolCallPart`/renderer DTO 改变 renderer wire，因此同时 bump Desktop `PROTOCOL_VERSION`。不创建独立 plugin progress push channel，大型 image body继续走 `SessionImageResource`。

## 22. Compatibility 和迁移

### 22.1 Existing extensions

- 没有 `desktopPlugin` named export 的 existing extension 行为不变；
- existing `registerTool()` tools 继续直接可见，包括当前 active-tool preference；
- existing plugin 没有 `pi.skills` 时不自动扫描 artifact 中的 `skills/`；
- loose development files 继续可加载，但因为没有稳定 manifest plugin ID/catalog/skill admission，不能提供 `desktopPlugin` methods；
- 不把现有 ToolDefinition 的 `content/details` adapter 成 method result，因为该 contract 面向模型和 UI，不是 canonical JSON API；
- plugin method namespaced registry 与 built-in tool names不发生 override；
- old session 的 direct plugin tool calls 继续按普通历史 tool part replay。

### 22.2 Plugin author migration

迁移一个 direct tool：

1. 把一个多字段 tool 参数整理成单个 object schema；
2. 把结果改为 canonical JSON value，不返回模型文案；
3. 将图片/文件改用 `ctx.attach()`；
4. 把 method definitions 放入 entry module 的 `export const desktopPlugin`；不要通过 `pi` 注册；
5. 从同一 declaration source 生成 catalog 和 API reference；
6. 写 primary `SKILL.md` 及必要 workflow prose；
7. manifest 声明 skills、pluginCall catalog 和 `plugin-methods.provide`；
8. 删除旧 `registerTool()` 只有在作者接受不再直接调用后进行，不提供双注册兼容层。

同一能力同时以 direct tool 和 plugin method 注册会增加 schema 和歧义，Marketplace lint 应 warning，但首期不禁止。

### 22.3 No backward-compatibility alias

method rename、参数变化和 result shape 变化由插件版本、catalog 及 skill 文档管理。runtime 不保留旧 method alias，也不把未知调用重写到相似名称。需要迁移期时插件作者显式注册旧 method，并在 skill 标记 deprecated。

## 23. Implementation map

### 23.1 Pi packages

`packages/ai`、`packages/agent`、`packages/coding-agent` 和 `packages/tui` 均不修改。具体约束：

- 不新增或扩展 Pi public/private types；
- 不修改 `ExtensionAPI`、extension loader/runner、`DefaultResourceLoader`、`AgentSession` 或 agent loop；
- 不向 Pi extension/load result 保存 hidden methods；
- 只由 Desktop inline extension 使用当前公开 `pi.registerTool()` 注册一个普通 `plugin_call`；
- Pi 升级仍只通过现有 public compatibility characterization 验证。

任何实现阶段发现必须修改 Pi 才能继续时，应停止并回到本规范重新设计，不能把该修改作为隐含前置补丁。

### 23.2 Desktop main/marketplace

修改：

- `src/main/plugins/marketplace-artifact-manifest.ts`：manifest skills/catalog、primary skill、capability 和 path validation；
- `src/main/plugins/marketplace-plugin-installer.ts`、registry、reconciler、garbage collector：persist/clone/version reference；
- `src/main/extensions/desktop-extension-directory.ts`：Development plugin resources resolution；
- `src/main/extensions/desktop-extension-source-policy.ts`：resolved paths、fingerprint、override identity；
- `src/shared/desktop-extension-contracts.ts`：capability 和 resolved entry fields；
- plugin publish/create skills 和 verifier：生成并检查 method-based package。

### 23.3 Desktop thread sidecar

新增建议：

```text
packages/desktop/src/main/pi/plugin-call/
  plugin-method-registry.ts
  plugin-method-dispatcher.ts
  plugin-call-tool.ts
  plugin-call-runtime.ts
  plugin-call-worker.ts
  plugin-call-protocol.ts
  plugin-call-json.ts
  plugin-call-limits.ts
  plugin-call-errors.ts
```

修改：

- `desktop-extension-runtime-policy.ts`：完整 module namespace import、per-entry declaration staging/commit、approved identity/capability gate 和 skill paths；
- `session-runtime.ts`：在 AgentSession 创建前完成 builder finalization，持有 registry/runtime/tool closure 和 disposal；
- `pi-thread-projector.ts`：plugin details、image/file attachment projection；
- shared contracts：Desktop capability、resolved catalog/skill fields 和 renderer DTO；
- Desktop sidecar build：确保 method declarations、worker bootstrap 和 plugin-create 本地 type helper 只来自 Desktop 产物。

这些文件位于当前代码布局中的 `src/main/pi`，但随 thread sidecar bundle 执行；不能据目录名误放到 Electron main process runtime。

### 23.4 Renderer

修改 `tool-view.tsx` 和 focused tool components，为 `plugin_call` 增加专用 header、sub-call list、logs 和 attachments。不要增加 renderer-side dispatcher 或 executable tool。

## 24. Test plan

### 24.1 Declaration and exposure

- `desktopPlugin` methods 不出现在 Pi registered tools、active tools、system prompt tool schemas、snippets、guidelines 或 deferred definitions；
- module import + declaration validation + optional default factory 都成功才 commit staged methods；任一步失败都 discard；
- named export missing/unexpected、accessor/class/symbol/unexpected field、Proxy trap failure、duplicate method、invalid name、non-object params、bad schema；
- transparent Proxy 不被错误描述为可检测的安全违规；
- capability absent/present mismatch、catalog metadata missing 和 approved entry identity binding；
- default factory 中尝试后续 mutate declaration 不改变 frozen registry；
- two plugins can use same method name；
- Development override 使用 manifest plugin ID；
- zero candidate 不注入 tool factory；candidate startup 成功后 provider request 保持 native tools 并只新增一个 `plugin_call`；
- ordinary extension 注册保留名 `plugin_call` 时，使用现有 Pi loader duplicate/load error 作为 blocking startup diagnostic；Desktop 不覆盖该 tool，也不要求 Pi 提供 owner attribution；
- repository diff 证明 Pi packages 零修改。

### 24.2 Manifest、catalog 和 skills

- Marketplace/Development valid resources；
- absolute path、`..` escape、symlink、missing file、wrong filename、duplicate path、oversized metadata；
- primary skill missing/name mismatch/name collision/source mismatch/`disable-model-invocation: true`；
- primary skill 的 read/frontmatter/name/description warnings 全部 blocking，supplemental warnings 保持 lenient；
- Desktop finalizer 对 exact plugin skill path 做 blocking startup gate，但不修改 ordinary skills 或既有 `skillsOverride` 结果；
- catalog parse、stable order、module declaration drift；
- extension load failure 阻止 live AgentSession 创建，不能暴露 methods 或 skills 给 provider；
- disabled/out-of-scope plugin 不贡献 skill；
- global/project skill precedence不 shadow plugin primary skill；
- version update 中旧 generation 保留旧 resource paths；
- garbage collection 不删除 active generation referenced version。

### 24.3 Namespace

- `plugin.browser.get`；
- `plugin["com.acme.browser"].get`；
- `plugin.com.acme.browser.get`；
- hyphen segment bracket access；
- prefix plugin IDs 共存；
- unknown plugin/method；
- `__proto__`/constructor/prototype pollution attempts；
- method is always async and called with exactly one object。

### 24.4 Validation 和 JSON

- valid params/result 和 closed schema profile 每个允许 kind；
- 禁止 ref/transform/unsafe/default/coercion/custom format，并以包含 astral/BMP property keys 的 fixture 锁定 RFC 8785 UTF-16 ordering；
- packaging/runtime shared canonicalizer 产生相同 catalog bytes；
- additional property、required、format、nested diagnostic；
- result schema failure；
- `undefined` fields、BigInt、NaN、Infinity、cycle、deep object、accessor/proxy、Date、typed arrays、class instance；
- null-prototype plain JSON；
- bridge structured clone failure；
- per-response and cumulative byte caps；
- large intermediate result does not enter transcript。

### 24.5 Runtime

- top-level await/return 和 erasable TS；
- enum/static import syntax failure；
- dynamic Node import、filesystem、network fixture 和 tracked subprocess capability；
- supported `worker_threads.Worker`/`cluster` creation 被拒绝，故意恢复 binding 仅属于 documented full-authority bypass；
- `detached: true` 被拒绝，normal descendants 在 success/error/timeout/abort/dispose 后完成 TERM/KILL cleanup；
- fresh worker state；
- sync infinite loop compute/wall timeout；
- never-settling promise wall timeout；
- heap exhaustion worker exit；
- code throw/non-Error throw；
- forged/malformed/duplicate messages do not crash sidecar；
- code/log/output/depth limits；
- worker is awaited on every terminal path；
- failed run 后 subsequent run 正常。

### 24.6 Cancellation 和 concurrency

- abort before spawn、while queued、during code、during method，以及 Pi signal 为 `undefined`；
- host-owned root controller 保留 normalized abort reason，handler observes exact child signal；
- progress depth/JSON/per-value/cumulative limits、100 ms coalescing 和 terminal flush；
- late result/progress/attachment ignored；
- serial FIFO within plugin；
- cross-plugin parallel；
- method `parallel` opt-in；
- global concurrency and call count limits；
- concurrent outer runs share plugin serial lane；
- generation disposal aborts all work；
- update/reload during run 不切换 registry；
- replacement receives no late event；
- completed side effects不被描述为 rolled back。

### 24.7 Attachments

- image validation、MIME、base64、per-run total；
- image appears once in model content and once as timeline resource ref；
- file opaque artifact ID、private-root rejection、renderer path/hash redaction、sidecar resolve command、same-path replacement 和 missing-after-replay；
- renderer never receives canonical path；
- attachment count/size failure；
- failed/aborted sub-call attachments discarded；
- outer failure 不发布 partially collected attachments。

### 24.8 Pi/Desktop integration

- zero methods 时没有 `plugin_call`；N plugins 时恰好一个；
- Pi built-in tool list and behavior unchanged；
- outer hooks run once，nested method 不生成伪 Pi hooks/events；
- one outer Pi tool lifecycle with nested details；
- partial details do not complete assistant-ui tool part；
- terminal success/error replay；
- bootstrap/live `PiToolCallPart.pluginCall` projection equivalence；
- renderer/sidecar protocol version bumps 和 artifact open routing；
- reconnect/resync；
- cancel、reload、branch、compaction 和 session reopen；
- model context contains outer value but not logs/audit/intermediate results；
- renderer never executes backend plugin method；
- subagent 没有 registry 时不注入 plugin skill。

## 25. Delivery phases

### Phase 1: Desktop module declaration

- add Desktop declaration types/template、module namespace loader 和 generation-local registry builder；
- add Desktop capability、catalog metadata 和 canonical identity mapping；
- add staging/commit/discard、Pi-zero-change 和 no-exposure tests。

Exit：methods 可被 Desktop registry 枚举，模型 tool list 完全不变，Pi packages 没有文件变更。

### Phase 2: Packaging and progressive disclosure

- manifest、catalog parser/generator、installer、registry、source policy 和 Desktop atomic skill admission；
- update plugin-create/plugin-publish validation for `desktopPlugin` declarations；
- add one method-based example plugin。

Exit：enabled plugin 的 skill summary 可见，disabled/failed/drifted plugin 的 skill 不可见，API schema 未进入 initial prompt。

### Phase 3: Runtime and dispatcher

- worker protocol、type stripping、dynamic namespace、validation、limits、abort、concurrency；
- fixed `plugin_call` tool；
- structured errors and audit details。

Exit：example plugin 能完成多次中间调用，只把 outer return 写入 tool result。

### Phase 4: Attachments and Desktop UI

- image/file side channel；
- projector resource handling；
- dedicated renderer details。

Exit：image、file、progress、error 和 replay 行为通过 integration tests。

### Phase 5: Migration and rollout

- migrate selected Marketplace/curated plugins；
- compare initial schema token count、task success rate、call latency 和 self-correction rate；
- document author migration；
- keep direct tools only for intentional exceptions。

## 26. Acceptance criteria

本规范实现完成必须同时满足：

1. 启用至少一个 method-based plugin 时，provider request 中只新增 `plugin_call` 一个 tool schema。
2. 任意 plugin method schema、description 和 catalog 均不在初始 provider request/system prompt 中。
3. 相关 plugin skill 的 name/description 在初始 skill metadata 中，完整正文只在模型读取后进入上下文。
4. `plugin_call` 可使用真实 canonical plugin ID 调用方法，并支持 Marketplace dotted/hyphenated ID。
5. 参数与结果的 schema/JSON validation 在 Desktop dispatcher 的 extension handler 边界两侧生效，catalog 与 module declaration 无漂移。
6. 中间 method values、logs 和 audit records 不进入 model transcript。
7. outer return、stable errors 和允许的 images 按本规范进入一个 Pi tool result。
8. timeout、abort、heap、depth、call、response、output 和 attachment limits 有 focused tests。
9. generation replacement 后旧 registry、worker、handler completion 和 attachment 不能污染新 session runtime。
10. Pi built-in tools、ordinary direct extension tools、agent loop、session JSONL 和 assistant-ui backend-tool non-execution 行为无回归。
11. Marketplace install/update/rollback/garbage collection 同时正确管理 entry、catalog 与 skill version paths。
12. nested methods 的有意语义差异有测试，不能被误认为经过 Pi tool hooks。
13. `npm run check` 以及所有新增 focused tests 通过。
