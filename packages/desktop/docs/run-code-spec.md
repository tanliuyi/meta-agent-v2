# Meta Agent Desktop run_code 规范

> 状态：Draft（registerTool capture 架构已确定）
>
> 适用范围：`packages/desktop` 的插件制品协议、受控插件加载、thread sidecar、Pi timeline 投影和 Desktop tool UI
>
> 目标版本：Desktop Extension Host Profile v1 的增量能力
>
> 设计目的：减少模型初始可见 tool schema 的数量和 token，占用一个固定 `run_code` tool 承载 Desktop 插件方法；Pi 内建工具保持原样。

## 1. 摘要

Desktop 在受控插件 factory 执行期间代理 `ExtensionAPI.registerTool()`。插件仍按标准 Pi Extension API 注册工具，不需要增加 `desktopPlugin` named export，也不需要维护另一套 execute/schema/result adapter。Desktop 捕获完整 `ToolDefinition`，将其放入当前 thread worker generation 的 session-scoped registry，但不把这些定义交给 Pi 的模型 tool registry。模型只看到 Desktop inline extension 注册的一个固定 `run_code` tool，并通过 TypeScript 程序调用：

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
    = 当前 extension generation 中捕获的标准 Pi ToolDefinition

run_code
    = 唯一的 Desktop 插件工具模型入口

plugin.<pluginId>.<toolName>(args)
    = run_code worker 中的动态异步 API

Plugin SKILL.md
    = 按需披露的方法签名、语义和工作流
```

这不是 PTC（Programmatic Tool Calling）模式。Desktop 不把 `read`、`bash`、`edit`、`subagent` 等 Pi 工具折叠到代码执行器，也不增加统一 `run_code`。聚合边界覆盖 Desktop 托管插件通过 `pi.registerTool()` 注册的工具。插件的 commands、events、providers、messages 和 Host UI 能力继续通过同一个真实 `ExtensionAPI` 使用；只有 `registerTool` 在 per-entry wrapper 中被捕获。Pi 内建工具不进入该 registry。

## 2. 规范优先级

本规范是 Desktop plugin method aggregation 的 authority。与既有规范的关系如下：

- [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 继续负责 main-owned approved entry set、Host Profile、Developer Mode、extension capabilities 和 immutable worker generation；
- [`plugin-marketplace-product-spec.md`](./plugin-marketplace-product-spec.md) 继续负责 Marketplace 分发、安装、版本目录、registry、更新和卸载；
- [`node-sidecar-per-thread-spec.md`](./node-sidecar-per-thread-spec.md) 继续负责 Electron embedded Node、thread single writer、worker replacement、sidecar protocol 和进程生命周期；
- [`pi-native-assistant-ui-runtime-spec.md`](./pi-native-assistant-ui-runtime-spec.md) 继续负责 Pi message/tool lifecycle 到 Desktop timeline 和 assistant-ui 的投影；
- Pi `AgentSession`、extension API、extension runner、agent loop、tool validation、session JSONL 和 compaction 语义保持权威且不作任何修改；
- 本规范只新增 hidden plugin methods、插件 skill admission、`run_code` runtime 和对应 UI details。

`tools.register` 保持标准 Pi direct tool 语义。只有声明 `plugin-methods.provide` 并携带 primary skill/catalog metadata 的插件才由 Desktop 捕获。

本规范同时对 sidecar no-orphan 条款作一个窄化：host-owned descendants、插件经 Host API 启动的 descendants，以及生成代码通过受支持 `node:child_process` wrapper 启动的 descendants 仍必须在 outer run/dispose 时清理；拥有完整 Node authority 并故意绕过 wrapper、daemonize 或重新脱离进程组的代码不在可强制保证范围。该例外必须在产品全信任说明中明确，不能把 worker thread 描述成安全边界。

## 3. 目标

### 3.1 产品目标

1. 无论启用多少个 Desktop 插件、每个插件注册多少工具，模型最多新增一个 `run_code` tool schema。
2. 单个插件工具的名称、参数 schema 和结果不进入初始模型 tool list。
3. 模型根据任务选择并读取相关 plugin skill，不预加载所有插件 API 文档。
4. Pi 内建工具继续直接可见、直接执行，不改变现有提示词和交互习惯。
5. 插件调用在 Desktop tool row 中保持可观察，包括程序描述、子调用、耗时、失败和附件。
6. Desktop 为被捕获工具提供原始 `ExtensionContext`、abort、`onUpdate`、配置及已批准 Host API 能力，不以聚合为由降级插件能力。

### 3.2 工程目标

1. plugin registry 与 `ResolvedExtensionSet.generation`、project 和 thread 绑定。
2. 只有 main 批准，且 Desktop wrapper 成功导入、校验并加载的插件可以贡献 methods 和 skills。
3. 参数和结果分别经过 TypeBox schema 校验及 lossless JSON 校验。
4. abort、wall/compute timeout、worker termination、heap cap、调用数限制和输出限制有明确语义。
5. 中间 method result 只在 code worker 与 sidecar dispatcher 之间流动，不追加为 Pi tool result 或 conversation message。
6. 一个 `run_code` 只产生一个 Pi tool lifecycle；内部方法调用作为 UI/audit details，不伪造成嵌套 Pi tools。
7. reload、replacement 和 worker crash 后不复用旧 generation 的 registry、handler、signal 或结果。

## 4. 非目标

首期不包括：

- 修改 `packages/ai`、`packages/agent`、`packages/coding-agent`、`packages/tui` 或任何 Pi public/private API；
- 通过 `pi.registerPluginMethod()`、扩展 `ExtensionAPI`、修改 `ExtensionRunner` 或增加 `ResourceLoader` hook 来保存 plugin methods；
- 把 Pi built-in tools 聚合进 `run_code`；
- 要求插件作者为已有 `registerTool()` 工具维护第二套 executable declaration；
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

1. `run_code` 之外的 Pi active tool set 与本功能启用前一致。
2. method-based 插件数量从 1 增加到 N 时，模型 tool schema 数量不随 N 增加。
3. `DesktopPluginMethodDefinition.parameters`、`result`、method description 和 generated catalog 不进入初始 system prompt。
4. 初始 prompt 对每个 admitted skill 只使用 Pi 现有 skill metadata 格式。
5. registry key 使用 Desktop 批准的 canonical plugin ID；插件代码不能自报或覆盖 plugin ID。
6. `run_code` 是 Desktop 保留 tool name。Desktop 只向现有 Pi loader 注入一个同名 inline factory；不修改 Pi 去追踪 tool owner。若现有 Pi loader 因同名 tool 冲突返回 load error，Desktop 将其作为 blocking startup diagnostic，不覆盖、first-win 或静默替换其他 tool。
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

Desktop 受控 wrapper 从插件的标准 `pi.registerTool()` 调用捕获的工具。它保留 ToolDefinition 的参数 schema、`prepareArguments`、`executionMode` 和 execute closure；执行时接收真实 `ExtensionContext`、abort 和 update callback。

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

插件制品中的机器生成 `plugin-api.json`。它记录预期工具及 schemas，用于文档、skill reference 和增强 admission 检查，但不作为 executable source，也不进入模型上下文。旧 `tools.register` 制品可以没有 catalog。

### 6.5 Outer run

一次模型对 `run_code` 的调用及其 fresh code worker。

### 6.6 Sub-call

outer run 内一次 `plugin.<pluginId>.<method>(args)` 调用。sub-call 不成为 Pi tool call，只进入 bounded execution details 和 audit sink。

## 7. 模型暴露面

### 7.1 固定 tool schema

`run_code` 由 Desktop 自有 inline extension factory 使用现有 `pi.registerTool()` 注册。该 factory 使用固定 internal identity，例如 `<inline:desktop-run-code>`。`controlledResourceLoaderOptions()` 只在 approved resolved set 中至少有一个可贡献工具的插件时加入该 factory。插件注册同名 `run_code` 会在 per-entry capture 时因保留名称而 admission 失败；Desktop 不覆盖或静默替换。若 factory、captured tool、catalog 或 skill validation 失败，Desktop 在任何 provider request 之前终止 session startup。

固定 schema 如下：

```ts
const RunCodeParameters = Type.Object(
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
  name: "run_code",
  label: "Run code",
  description:
    "Execute an erasable TypeScript program using enabled Desktop plugin APIs. " +
    "Read the relevant plugin skill before use. Return only the final value needed by the model.",
  parameters: RunCodeParameters,
  executionMode: "parallel",
}
```

`run_code` description 不列出插件、method、参数或 result schema。Pi 的普通 tool argument validation 继续校验 `code` 和 `description`。

### 7.2 Tool list

启用本功能后的模型 tool list 是：

```text
existing Pi built-in tools
+ run_code (only when at least one Desktop plugin tool is admitted)
```

Desktop 托管插件调用 `registerTool()` 表示声明完整原生工具能力，不表示要求直接暴露给模型。per-entry wrapper 捕获定义后必须保留 `prepareArguments`、`executionMode` 和 `execute`，并在执行时传入 outer call 的真实 `ExtensionContext`、abort signal 与 update callback。只有 Desktop 自有基础设施明确列入 native allowlist 的工具可以绕过该捕获边界；普通 Marketplace、Development、curated 和 builtin 插件没有自行选择 direct exposure 的入口。

### 7.3 Progressive disclosure

Pi 现有 `formatSkillsForPrompt()` 继续只投影每个 skill 的 name、description 和 location。Desktop 不增加 method catalog、generated SDK declaration 或 method schema system section。

推荐流程：

```text
user task
  -> model sees plugin skill summary
  -> model reads the matching SKILL.md
  -> skill optionally points to references/api.md
  -> model writes one run_code program
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
    "runCode": {
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
4. `pi.runCode.skill` 是 enhanced run-code 制品的 primary skill name；它必须与一个 admitted `SKILL.md` frontmatter `name` 精确相等。
5. 新制品声明 `plugin-methods.provide` 时，`skills`、`runCode.skill` 和 `runCode.catalog` 必填；default factory 必须实际调用 `registerTool()`。
6. 声明 `tools.register` 的插件继续作为 native direct tools，不进入 `run_code` registry。
7. manifest parser 校验 bounded catalog，返回 canonical skill/catalog paths、catalog digest 和 parsed catalog。catalog 是文档/admission metadata，不承载 execute closure。
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

catalog 和 `references/api.md` 由生成命令从标准 tool registrations 生成，methods 按 name 排序。runtime 不从 catalog 构造 handler；每个 captured tool 的名称、参数、结果及并发模式必须匹配 catalog。catalog 可以包含因运行时配置未注册的可选方法，运行时描述也可以包含配置化内容。插件 ID、实际注册的方法名或调用 schema 不一致时 admission 失败。参数 runtime validation 使用实际 ToolDefinition schema。

Plugin method schema 是 closed profile，不接受任意 TypeBox runtime feature：

- 允许 `Object`、`Array`、`Tuple`、`String`、`Number`、`Integer`、`Boolean`、`Null`、`Literal`、`Union` 和 `Optional`；
- object property key 必须是普通字符串，parameters root 必须 `additionalProperties: false`；
- 禁止 `$ref`、`$id`、recursive/self reference、`Transform`、`Unsafe`、custom kind、symbol metadata、default/coercion 和 executable validator；
- 允许的 string formats 固定为 `uri`、`date-time`、`email`、`uuid`、`hostname`、`ipv4`、`ipv6`，由 packaging/runtime 共用 format registry；其他 format registration 不参与 methods；
- schema 自身必须是最大 64 层、256 KiB 的 lossless JSON object；
- schema 比较使用 Desktop 现有 JSON snapshot/canonical JSON helper，保留 array order，并按稳定的 property order 比较；不比较对象 identity；
- packaging 只负责生成和解析 catalog，runtime 使用捕获的 TypeBox schema 编译 validator；两侧不共享不存在的 executable schema compiler。

runtime validation 只检查，不填 default、不 coerce、不删除 unknown fields。

catalog 不代表授权，不发送给 provider，也不要求模型读取。`SKILL.md` 的解释性 prose 无法完全机器验证；生成的 `references/api.md` 应来自同一 catalog，Marketplace verifier 至少检查 primary skill 引用了该 generated reference。

### 8.3 Development plugin

目录型 Development plugin 使用相同 manifest 字段。所有 entry、skill 和 catalog path 相对用户选择的 plugin directory 解析，并执行 containment、regular-file 和 symlink 检查。

单文件 loose development extension 没有稳定 plugin root、canonical plugin ID 或 skill admission，因此首期不能注册 plugin methods；它仍可使用普通 Pi extension API。

### 8.4 Curated 和 builtin plugin

`DesktopExtensionDefinition` 增加可选的 `skillPaths`、`runCodeSkill`、`runCodeCatalogPath` 和 `runCodeCatalogSha256`。curated resources 必须位于 `curatedRoot`；builtin resources 必须是随 Desktop sidecar 打包的静态路径。main source policy 读取 path、核对或生成 digest，并产出与 Marketplace 相同的 parsed `runCodeCatalog`。两者仍经过相同的 catalog、frontmatter 和 name collision 校验。

不是所有 inline factory 都是 plugin namespace。Desktop provider 等没有 run-code metadata 的 builtin inline extension 不得贡献 methods。

### 8.5 Resolved contracts

```ts
interface ResolvedExtensionEntry {
  // existing fields
  skillPaths?: string[];
  runCodeSkill?: string;
  runCodeCatalogPath?: string;
  runCodeCatalogSha256?: string;
  runCodeCatalog?: PluginApiCatalogV1;
}

interface InstalledMarketplacePluginRecord {
  // existing fields
  skillPaths?: string[];
  runCodeSkill?: string;
  runCodeCatalogPath?: string;
  runCodeCatalogSha256?: string;
}
```

这些 paths 必须已经 canonicalize，catalog 必须是 main 按第 8.2 节解析的 bounded detached JSON，digest 是原始 catalog file 的 SHA-256。clone、fingerprint、registry persistence、ownership marker、generation comparison 和 sidecar binding 都必须包含相应字段；fingerprint 至少包含 digest，不拼接整个 catalog。更新插件版本后，运行中的旧 worker 继续引用旧 version root 中的 entry、catalog 和 skill；garbage collector 必须把 active worker generation 的所有 paths 一起视为版本引用。

### 8.6 Desktop-owned atomic admission

不修改 `DefaultResourceLoader`，也不增加 post-resource hook。Desktop 利用现有 `extensionFactories` 和 `additionalSkillPaths` 完成 admission：

1. main 解析并批准 entry、canonical plugin ID、capabilities 以及可选的 skill/catalog metadata；
2. `SessionRuntime.create()` 创建 generation-local `DesktopPluginRegistryBuilder`，并把它传给 `controlledResourceLoaderOptions()`；
3. 对每个 path-backed entry，Desktop 继续生成 identity-bound inline wrapper，并用 `jiti` 导入 module namespace；
4. wrapper 调用 standard default factory，并代理 `registerTool()`：每个 ToolDefinition 进入 entry-local staging，其他 Host API 原样转发；factory throw 时 rollback；
5. factory 返回后再次调用 `registerTool()` 是 registration error；
6. `ResourceLoader` 按现有行为加载普通 skills、Desktop builtin skills 和 approved plugin skills；
7. services 创建完成后，Desktop 检查 extension diagnostics、captured definitions、catalog compatibility 和 primary skill；
8. 所有检查成功后 builder finalize 为本代 registry snapshot，再创建 AgentSession；
9. metadata/draft worker执行相同 factory capture/admission，但不注入 executable `run_code`，验证后丢弃 registry。

`SessionRuntime.create()` 的顺序必须可直接实现为：先创建 holder/builder；用它构造 `controlledResourceLoaderOptions()`；await `createAgentSessionServices()` 完成 extension/resource loading；执行 Desktop finalization；把 registry snapshot bind 到 holder；最后调用现有的 `createAgentSessionFromServices()`。Pi services 对象在此阶段已完成 loader work，但尚未创建 `AgentSession`；finalization 失败时先 `builder.discard()`，dispose 已创建的 services resources，再抛出 `DesktopExtensionStartupError`。不得先创建 AgentSession 再补 registry。reload 成功后重新 finalize 并 bind 当前 snapshot。

`controlledResourceLoaderOptions()` 只在 resolved set 至少包含一个已批准、catalog 非空的 method-based plugin 时加入 Desktop `run_code` inline factory。该 factory 只调用现有 `pi.registerTool()` 一次，tool 的 `execute` closure 捕获 generation-local registry holder；holder 未绑定、startup 已失败或 generation stale 时拒绝执行。因为 AgentSession 在 registry 绑定后才创建，正常 provider 路径永远看不到未就绪 tool。

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

## 9. Desktop tool capture contract

### 9.1 Standard plugin contract

插件继续使用标准 Pi API：

```ts
export default function setupPiExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get",
    label: "Get",
    description: "Fetch a web page and return extracted content",
    parameters: Type.Object(
      { url: Type.String({ format: "uri" }) },
      { additionalProperties: false },
    ),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return fetchPage(toolCallId, params.url, signal, onUpdate, ctx);
    },
  });
}
```

插件不导入 Desktop private types，不导出第二套 execute function。default factory 中的标准 `pi.registerTool()` 是唯一 executable source。

### 9.2 Capture and attribution

所有 discovery 和 attribution 都在 `desktop-extension-runtime-policy.ts` 的 per-entry wrapper 内完成：

1. wrapper 已闭包绑定 approved `ResolvedExtensionEntry`，canonical plugin ID 不能由插件自报；
2. wrapper 代理 exact factory invocation 的 `registerTool()`，其他 `ExtensionAPI` 成员仍转发到真实 host API；
3. 每次注册同步校验 tool name、description、parameters、`prepareArguments`、`executionMode` 和 execute function，并 stage 到 entry-local builder；
4. default factory 成功完成后才 commit；throw、重复名称或 catalog admission 失败全部 rollback；
5. captured definitions 不传给 Pi `registerTool()`，因此不会进入 active tools、provider schema、snippets 或 guidelines；
6. commit 后的 registry snapshot 不再接受该插件的新方法；资源重载会重新捕获并绑定新的 snapshot。

不得使用可变全局 `currentPluginId`、`AsyncLocalStorage`、调用栈推断或插件自报 ID 做 attribution。

### 9.3 Execution compatibility

dispatcher 调用 captured tool 时必须按 Pi `ToolDefinition` 语义提供：

- 先调用可选 `prepareArguments()`，再使用 captured TypeBox schema 校验；
- `toolCallId` 使用 sub-call ID；
- `signal` 来自 outer root controller；
- `onUpdate` 映射到 bounded `reportProgress()`；
- `ctx` 是当前 outer Pi tool execution 的真实 `ExtensionContext`，包括 session、model、cwd 和 Desktop Host UI bridge；
- final text content 转成 `{ text: string }` method value；image content 通过 attachment channel 提交；
- tool throw 保持 method failure，不能编码成成功文本；
- late update、result 和 UI interaction继续受 generation/run guard 约束。

如果未来发现 `AgentToolResult` 的 usage、terminate、dynamic tools 或其他字段无法等价投影，Desktop 必须新增明确 adapter contract 或保留 host-owned native exception；不得静默丢弃并声称完整兼容。

### 9.4 Catalog and skill

catalog 和 skill 是制品文档/admission metadata，不是第二份 executable source。runtime method set 来自实际 captured registrations。对于 `plugin-methods.provide` 制品，每个捕获定义必须属于 catalog 并匹配调用 schema；catalog 可保留因配置未启用的方法。参数验证使用实际 ToolDefinition schema。`tools.register` 制品继续作为 native direct tools。

primary skill 继续提供语义、工作流、副作用和 canonical namespace。generated API reference 可以从捕获定义或 packaging 时的标准 tool registration fixture 生成，但插件作者不维护另一套 handler。

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

registry 按 `ResolvedExtensionSet.entries` 的 approved order 构建，但 plugin/tool identity 不使用 first-wins。任何重复 canonical plugin ID 或 tool name 都产生 blocking diagnostic。只有 factory、capture 以及已声明的 catalog/primary skill checks 成功后，registry snapshot 才交给 `run_code`。

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

bracket form 是所有合法 ID 的无歧义 canonical syntax，plugin skill 必须至少展示一次。运行时用 null-prototype objects 和 own-property lookup 构建 namespace，不沿原型链解析。点分层级与完整 bracket key 指向同一个稳定 plugin namespace。

## 11. `run_code` code runtime

### 11.1 Topology

```text
model tool call
  -> Pi agent loop validates run_code args and runs outer tool hooks
  -> thread sidecar RunCodeTool.execute()
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

外层 `run_code` 是普通 `ToolDefinition`，完整经过 Pi 现有 argument preparation/schema validation、`tool_call` hooks、execution events、`tool_result` hooks、result normalization 和 transcript persistence。

内部 plugin method 不是 `ToolDefinition`，故意不经过以下 Pi tool-only 语义：

- `prepareArguments`；
- `tool_call` argument mutation/block hooks；
- `tool_result` content/details replacement hooks；
- active-tool changes 和 `addedToolNames`；
- method-specific `usage`、`terminate`；
- 独立 Pi `tool_execution_*` events 和 toolResult message。

原因是 provider transcript 中不存在对应的 nested tool call；伪造这些事件会造成 unmatched tool lifecycle。method dispatcher 必须独立实现本规范要求的 validation、source attribution、cancellation、concurrency、progress、attachments 和 audit，不复制 Pi tool wrapper 并声称两者语义相同。

需要 cross-cutting policy 的扩展应拦截外层 `run_code`，或未来使用专门的 `plugin_method_call/result` hook；首期不新增该 hook。插件方法本身的权限继续由 Desktop approved plugin 和全信任模型决定。

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

worker 发送的消息按 wire shape 校验：检查 message type、run token、integer call ID、plugin ID 和 method；malformed、duplicate 或 terminal 后 message 被丢弃，不能让 message listener throw 导致 sidecar crash。

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

同一 agent turn 中多个顶层 `run_code` 由 Pi 现有 tool execution scheduler 决定是否并行。每个 outer run 有独立 worker 和预算，但共享 session registry 的 plugin serial lanes，因而同一插件的默认 serial 约束跨 outer runs 生效。

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
  -> settle run_code with the originating stable error code
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
- `undefined`：返回 `(run_code completed with no output)`；
- image attachments：在 text content 后追加 Pi `ImageContent`；
UI-only logs、sub-call audit 和 private file records 使用以下 exact `details` contract，不加入 model text：

```ts
interface RunCodeDetails {
  kind: "run-code-details-v1";
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

`canonicalPath` 和 `sha256` 只存在于 sidecar-private details 和本地 JSONL。第 21 节 projector allowlist 必须把它转换为不含 path/hash 的 `PiRunCodeArtifact`；任何通用 JsonValue projector 都不得透传该 details object。

外层 JSON 在 stringify 前再次 schema-independent lossless snapshot，并按 UTF-8 JSON byte size 限制。超限是 explicit failure，不能静默截断成看似有效的 JSON。

### 15.3 Console

worker 注入只含 `log`、`info`、`warn`、`error`、`debug` 的 bounded console shim。console 输出用于 Desktop 展开详情和 diagnostics，不进入 LLM tool result content。不要把 host process 的原始 console object 直接传给生成代码。

## 16. Attachments

### 16.1 Collection

plugin handler 使用 `ctx.attach()`，附件不混入 JSON result。这样 code 可以继续处理纯 JSON，而 outer `run_code` 聚合调用链产生的 media。

每次 `attach()` 必须同步完成 shape、MIME、path、当前 regular-file stat 和声明 size budget admission；失败立即 throw，不到 handler 返回后再静默丢弃。附件先存入 sub-call-local staging。method result validation 成功后，dispatcher 异步完成 file hash/identity validation；全部成功才原子提交该 sub-call 的附件，否则 sub-call 以 attachment error 失败。failed/aborted sub-call 的附件全部丢弃。

### 16.2 Images

- `data` 是无 data-URL prefix 的 base64；
- MIME 必须是 Pi/provider 支持的 image MIME；
- host 校验 base64、decoded bytes 和 cumulative limit；
- admitted image 进入 final `AgentToolResult.content`，因此会作为 outer result 的附件进入模型上下文；
- Pi JSONL 按普通 toolResult image content 持久化 base64；
- projector 为每张图建立 `SessionImageResourceRef`，timeline 只保留 `resourceId` 和 MIME，body 继续通过 `sessions.readImageResource` 按需读取；
- `PiToolCallPart.runCode.attachments` 包含同一个 image ref，不复制 base64；
- outer run 失败或 abort 时不发布已收集 image。

### 16.3 Files

- relative path 按 session `cwd` 解析；absolute path 保留；
- `attach()` 同步解析路径、确认 regular file、记录初始 stat 并执行 file size budgets；method 成功后的 dispatcher commit phase 异步重新检查文件并计算 SHA-256，文件不存在、类型变化或大小超限时该 sub-call 失败；
- Pi toolResult `details` 中的 sidecar-private record 保存 canonical path、display name、MIME、size、SHA-256 和 artifact ID；它进入本地 session JSONL，但 projector 必须剥离 canonical path/hash，不能把原始 details 直接投影；
- artifact ID 使用 host 生成并持久化的随机 UUID；同一 tool result 内必须唯一，不能编码或泄露 path、session ID 或 generation；
- timeline/renderer 只得到 artifact ID、name、MIME 和 size；
- 当前 renderer 只显示附件名称，不显示 canonical path；文件内容不进入模型上下文；
- file bytes 不进入 model context。模型若需要内容，程序应由插件返回摘要，或使用现有 Pi `read` tool；
- renderer 通过 `sessions.openRunCodeArtifact({ projectId, threadId, toolCallId, artifactId })` 请求打开；main 把 opaque IDs 发给 owning thread sidecar，sidecar 从当前/replayed private details exact resolve canonical path，重新检查 regular file/size 并流式重算 SHA-256；只有 size/hash 都相等才把 path 返回 main执行受信任 open；renderer 永不接收 canonical path/hash；
- replay 时 projector 从持久化 details 重建 artifact lookup。文件已移动、删除、同路径替换或 size/hash 不匹配时，打开请求失败并显示 unavailable；
- outer run 失败或 abort 时不发布 file attachment。

## 17. Error contract

### 17.1 Stable codes

```ts
type RunCodeErrorCode =
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_METHOD_NOT_FOUND"
  | "PLUGIN_METHOD_INVALID_ARGUMENTS"
  | "PLUGIN_METHOD_EXECUTION_FAILED"
  | "PLUGIN_METHOD_INVALID_RESULT"
  | "PLUGIN_CALL_LIMIT_EXCEEDED"
  | "PLUGIN_RESPONSE_LIMIT_EXCEEDED"
  | "PLUGIN_PROGRESS_LIMIT_EXCEEDED"
  | "PLUGIN_ATTACHMENT_LIMIT_EXCEEDED"
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
  errorCode?: RunCodeErrorCode;
  progress?: JsonValue;
}
```

默认不把完整 params/results 放入 renderer details，防止重复大 payload 和 secret 泄露。开发诊断模式可以使用独立 redacted local audit sink，但不改变 session JSONL 或模型 context。

### 18.2 Pi lifecycle

外层仍只有：

```text
tool_execution_start(run_code)
tool_execution_update(run_code, RunCodeDetails summary)
tool_execution_end(run_code, AgentToolResult)
toolResult message fold
```

`reportProgress()` 和 sub-call transitions 可以节流合并为 outer `onUpdate()` details。partial update 不设置 terminal `result`，避免 assistant-ui 提前把 tool part 标记 complete。

### 18.3 Desktop renderer

`ToolView` 对 `run_code` 使用：

- label：`plugin`；
- target：模型提供的 `description`；
- collapsed row：running/complete/error 和 active/completed sub-call count；
- expanded body：logs、按 submission sequence 排列的 method waterfall、stable errors 和附件；
- 不在 collapsed title 展示 raw code；
- code、args 和 outer result 仍可在 expanded technical details 中查看，并遵守现有截断规则。

renderer 只展示 backend execution，不注册或执行 frontend tool implementation。首期 nested methods 使用 generic JSON/progress renderer；现有 browser、memory、subagent 等 specialized cards 继续只处理 native top-level tools，不按 method name 猜测复用。

### 18.4 Persistence

outer `run_code` 的 args、final result 和 bounded details 随普通 Pi toolResult 持久化。sub-call records 不是独立 timeline nodes，也没有独立 provider messages。重连/resync 从同一个 outer tool part 重建详情。

## 19. Capability model

`DesktopExtensionCapability` 新增纯 Desktop capability：

```ts
type DesktopExtensionCapability =
  | /* existing */
  | "plugin-methods.provide";
```

Desktop per-entry wrapper 必须 gate tool capture：

- `plugin-methods.provide` entry 必须有 canonical plugin ID、primary skill 和 parsed catalog；
- factory 的所有同步 `registerTool()` 调用按 approved entry attribution 并进入 staging；
- capture、factory 或 catalog equality 失败时 rollback 整个 entry；
- tool execution 不逐次向 main/renderer 请求授权；
- capability 只表示工具可由模型生成程序调用，不表示 OS 权限限制。

这里不依赖 Pi shared Host UI context 的 caller attribution。Desktop wrapper 由 `ResolvedExtensionEntry` 创建并闭包绑定 identity，在调用 factory 时代理 `registerTool()`。Host Profile 中“共享 Pi host 无 per-caller isolation”的限制保持不变，也无需修改 Pi。

`tools.register` 表示 native direct model exposure。需要组合调用的插件使用 `plugin-methods.provide` 并携带 skill/catalog；host-owned native infrastructure 继续按明确内建路径注册。

## 20. Session、draft、reload 和 persistence

### 20.1 New/open session

thread worker bootstrap 中的 `ResolvedExtensionSet` 决定 methods、catalog 和 skills。open existing session 时使用当前批准 generation 和该 session 的 `enabledPluginIds` 选择结果；session JSONL 不保存 method definitions 或 schemas。

new-session draft 和 live thread 必须从同一 main-owned source policy 解析 plugin metadata。metadata worker 可以验证/display manifests 和 skill summaries，但不创建 executable method registry，不暴露 `run_code`，也不运行模型代码。

### 20.2 Reload

插件启用状态、版本、配置、entry、skill、catalog 或 capability 变化都会改变 extension-set fingerprint，并通过现有 replacement worker 生效。不能在当前 registry 中 mutate。

资源-only reload 如果可能改变 plugin skill，也必须走 generation replacement；不能让同一 live registry 配上新 API 文档。

### 20.3 Replay

历史 `run_code` 作为普通 Pi tool call/result replay。重放只显示持久化的 outer args/result 和 bounded details，不重新执行 code，不要求当前仍安装相同插件，也不从当前 registry 反推历史 method metadata。

### 20.4 Child/subagent policy

首期 `run_code` 只注册在 Desktop live thread `SessionRuntime`。metadata workers、subagent workers和 standalone Pi CLI 不继承 parent registry。skill 可以按现有 subagent skill policy作为知识传入，但没有 matching `run_code` 时必须明确视为不可执行；默认不向 subagent 注入 plugin skills，避免广告不可用 API。

未来若 subagent 需要插件能力，必须把 approved extension generation、registry ownership、worker lifecycle 和 audit 回传作为独立设计，不能通过访问 parent thread singleton 绕过 single-writer/generation 边界。

## 21. Sidecar 和 renderer protocol

code worker bridge 是 thread sidecar 内部协议，不加入 Electron main wire。

本规范固定扩展 `PiToolCallPart`，不再把 attachment transport 留给实现判断：

```ts
interface PiToolCallPart {
  // existing fields
  runCode?: PiRunCodeArtifact;
}

interface PiRunCodeArtifact {
  kind: "run-code";
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

`runCode` 是 projector 从 persisted `AgentToolResult.details` 和 image content 生成的 allowlisted renderer DTO。bootstrap 和 live `tool-call-replaced` 必须调用同一个 pure converter。partial execution 时它进入 assistant-ui 的 UI-only `artifact`；terminal 时仍保留在 `artifact`，而正式 `result` 继续是现有 outer `AgentToolResult` projection。renderer 不得从 `result.details` 自行解析 private records。

新增 Desktop request：

```ts
interface OpenRunCodeArtifactInput {
  projectId: string;
  threadId: string;
  toolCallId: string;
  artifactId: string;
}
```

main 只接受当前 attachment lease 对应 thread 的请求，并向 owning thread worker 发 `resolveRunCodeArtifact` command；sidecar 返回 canonical path 给 main，不返回 renderer。该 command 和 result 改变 main/sidecar wire，因此 bump `SIDECAR_PROTOCOL_VERSION`；`PiToolCallPart`/renderer DTO 改变 renderer wire，因此同时 bump Desktop `PROTOCOL_VERSION`。不创建独立 plugin progress push channel，大型 image body继续走 `SessionImageResource`。

## 22. Compatibility 和迁移

### 22.1 Existing extensions

- existing `registerTool()` 插件代码无需修改；声明 `plugin-methods.provide` 时 Desktop 捕获其 ToolDefinition；
- `tools.register` manifest 继续作为 native direct tool 运行，可显式迁移为 `plugin-methods.provide`；
- existing plugin 的 commands、events、providers、configuration 和 Host UI 能力保持原样；
- loose development files 若没有稳定 canonical plugin ID，不能进入 namespaced registry；
- 捕获工具的 text/image result 由通用 adapter 投影，private details 不进入模型上下文；
- old session 的 direct plugin tool calls 继续按普通历史 tool part replay。

### 22.2 Plugin author migration

迁移旧制品不要求修改插件代码：

1. 保持现有 default factory 和 `pi.registerTool()` definitions；
2. 确认每个工具正确使用 `prepareArguments`、AbortSignal、`onUpdate` 和 `ExtensionContext`；
3. manifest 从 `tools.register` 迁到 `plugin-methods.provide`；
4. 增加 primary `SKILL.md`，说明 canonical namespace、参数、结果、副作用和工作流；
5. 从标准 tool registrations 生成 catalog 与 API reference；
6. 验证 Desktop provider request 只包含一个 `run_code` schema。

迁移前后的 executable source 都是同一份 ToolDefinition，不存在双注册兼容层。

### 22.3 No backward-compatibility alias

method rename、参数变化和 result shape 变化由插件版本、catalog 及 skill 文档管理。runtime 不保留旧 method alias，也不把未知调用重写到相似名称。需要迁移期时插件作者显式注册旧 method，并在 skill 标记 deprecated。

## 23. Implementation map

### 23.1 Pi packages

`packages/ai`、`packages/agent`、`packages/coding-agent` 和 `packages/tui` 均不修改。具体约束：

- 不新增或扩展 Pi public/private types；
- 不修改 `ExtensionAPI`、extension loader/runner、`DefaultResourceLoader`、`AgentSession` 或 agent loop；
- 不向 Pi extension/load result 保存 hidden methods；
- 只由 Desktop inline extension 使用当前公开 `pi.registerTool()` 注册一个普通 `run_code`；
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
packages/desktop/src/main/pi/run-code/
  plugin-method-registry.ts
  plugin-method-dispatcher.ts
  run-code-tool.ts
  run-code-runtime.ts
  run-code-worker.ts
  run-code-protocol.ts
  run-code-json.ts
  run-code-limits.ts
  run-code-errors.ts
```

修改：

- `desktop-extension-runtime-policy.ts`：完整 module namespace import、per-entry declaration staging/commit、approved identity/capability gate 和 skill paths；
- `session-runtime.ts`：在 AgentSession 创建前完成 builder finalization，持有 registry/runtime/tool closure 和 disposal；
- `pi-thread-projector.ts`：plugin details、image/file attachment projection；
- shared contracts：Desktop capability、resolved catalog/skill fields 和 renderer DTO；
- Desktop sidecar build：确保 capture adapter、worker bootstrap 和 plugin-create 文档只来自 Desktop 产物。

这些文件位于当前代码布局中的 `src/main/pi`，但随 thread sidecar bundle 执行；不能据目录名误放到 Electron main process runtime。

### 23.4 Renderer

修改 `tool-view.tsx` 和 focused tool components，为 `run_code` 增加专用 header、sub-call list、logs 和 attachments。不要增加 renderer-side dispatcher 或 executable tool。

## 24. Test plan

### 24.1 Capture and exposure

- captured `registerTool()` definitions 不出现在 Pi registered tools、active tools、system prompt tool schemas、snippets、guidelines 或 deferred definitions；
- module import + default factory + capture 都成功才 commit staged tools；任一步失败都 discard；
- duplicate method、invalid name、missing parameters/execute、unsupported execution mode 和 reserved `run_code` name；
- `prepareArguments`、actual TypeBox validation、AbortSignal、onUpdate 和 real ExtensionContext 均被保留；
- `tools.register` entry 保持 direct exposure，`plugin-methods.provide` entry 检查 catalog compatibility；
- two plugins can use same method name；
- Development override 使用 manifest plugin ID；
- zero candidate 不注入 tool factory；candidate startup 成功后 provider request 保持 native tools 并只新增一个 `run_code`；
- host-owned inline infrastructure 没有 plugin entry 时不被误拦截；
- repository diff 证明 Pi packages 零修改。

### 24.2 Manifest、catalog 和 skills

- Marketplace/Development valid resources；
- absolute path、`..` escape、symlink、missing file、wrong filename、duplicate path、oversized metadata；
- primary skill missing/name mismatch/name collision/source mismatch/`disable-model-invocation: true`；
- primary skill 的 read/frontmatter/name/description warnings 全部 blocking，supplemental warnings 保持 lenient；
- Desktop finalizer 对 exact plugin skill path 做 blocking startup gate，但不修改 ordinary skills 或既有 `skillsOverride` 结果；
- catalog parse、stable order、captured-definition compatibility；
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
- 禁止 ref/transform/unsafe/default/coercion/custom format，并验证 catalog 与运行时使用相同的 schema normalization；
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
- file opaque artifact ID、renderer 不暴露 canonical path/hash、sidecar resolve command、same-path replacement 和 missing-after-replay；
- renderer never receives canonical path；
- attachment count/size failure；
- failed/aborted sub-call attachments discarded；
- outer failure 不发布 partially collected attachments。

### 24.8 Pi/Desktop integration

- zero methods 时没有 `run_code`；N plugins 时恰好一个；
- Pi built-in tool list and behavior unchanged；
- outer hooks run once，nested method 不生成伪 Pi hooks/events；
- one outer Pi tool lifecycle with nested details；
- partial details do not complete assistant-ui tool part；
- terminal success/error replay；
- bootstrap/live `PiToolCallPart.runCode` projection equivalence；
- renderer/sidecar protocol version bumps 和 artifact open routing；
- reconnect/resync；
- cancel、reload、branch、compaction 和 session reopen；
- model context contains outer value but not logs/audit/intermediate results；
- renderer never executes backend plugin method；
- subagent 没有 registry 时不注入 plugin skill。

## 25. Delivery phases

### Phase 1: Desktop tool capture

- add per-entry `registerTool()` proxy、generation-local registry builder 和 ToolDefinition adapter；
- preserve prepareArguments、schema validation、execution context、abort、updates and result media；
- add staging/commit/discard 和 no-exposure tests。

Exit：methods 可被 Desktop registry 枚举，模型 tool list 完全不变，Pi packages 没有文件变更。

### Phase 2: Packaging and progressive disclosure

- manifest、catalog parser/generator、installer、registry、source policy 和 Desktop atomic skill admission；
- update plugin-create/plugin-publish validation for standard captured tool registrations；
- add one method-based example plugin。

Exit：enabled plugin 的 skill summary 可见，disabled/failed/drifted plugin 的 skill 不可见，API schema 未进入 initial prompt。

### Phase 3: Runtime and dispatcher

- worker protocol、type stripping、dynamic namespace、validation、limits、abort、concurrency；
- fixed `run_code` tool；
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
- remove legacy `desktopPlugin` compatibility；

## 26. Acceptance criteria

本规范实现完成必须同时满足：

1. 启用至少一个 method-based plugin 时，provider request 中只新增 `run_code` 一个 tool schema。
2. 任意 plugin method schema、description 和 catalog 均不在初始 provider request/system prompt 中。
3. 相关 plugin skill 的 name/description 在初始 skill metadata 中，完整正文只在模型读取后进入上下文。
4. `run_code` 可使用真实 canonical plugin ID 调用方法，并支持 Marketplace dotted/hyphenated ID。
5. 参数验证使用 captured ToolDefinition schema，结果/附件经过 Desktop adapter 和 lossless JSON 边界；captured definitions 是 catalog 中与当前配置对应的合法子集。
6. 中间 method values、logs 和 audit records 不进入 model transcript。
7. outer return、stable errors 和允许的 images 按本规范进入一个 Pi tool result。
8. timeout、abort、heap、depth、call、response、output 和 attachment limits 有 focused tests。
9. generation replacement 后旧 registry、worker、handler completion 和 attachment 不能污染新 session runtime。
10. Pi built-in tools、host-owned native infrastructure、agent loop、session JSONL 和 assistant-ui backend-tool non-execution 行为无回归。
11. Marketplace install/update/rollback/garbage collection 同时正确管理 entry、catalog 与 skill version paths。
12. nested methods 的有意语义差异有测试，不能被误认为经过 Pi tool hooks。
13. `npm run check` 以及所有新增 focused tests 通过。
