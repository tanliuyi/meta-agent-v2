# Desktop 模型设置规范

状态：Proposed
最后更新：2026-07-19

## 1. 目标

在 Desktop 设置中新增“模型”菜单和 `#/settings/models` 子路由，用结构化界面编辑 Pi CLI 与 Desktop 共同使用的 `models.json`。

本规范中的文件名统一指 `models.json`。默认路径是 `~/.pi/agent/models.json`，但实现必须使用 Desktop main 已解析的 `agentDir`，完整支持 `PI_CODING_AGENT_DIR`，不得在 renderer 中拼接 home 路径。

最终能力包括：

- 查看当前配置文件状态、实际路径、provider 和 model 数量；
- 新增、修改、删除 provider；
- 新增、修改、删除 custom model；
- 编辑 `modelOverrides`；
- 编辑当前 Pi schema 支持的 headers、cost、thinking level map 和 compat 字段；
- 在写盘前使用 Pi 的同一 parser、schema 和 semantic validator；
- 保留未编辑的 JSONC 注释、格式、配置值和未来未知字段；
- 检测外部修改，禁止静默 last-write-wins；
- 使用锁、revision 和原子替换安全写入配置。

该页面编辑的是模型目录配置，不是当前会话的模型选择器，也不管理 `settings.json` 中的默认模型。

## 2. 非目标

首期不实现：

- `/login`、OAuth 登录、OAuth token 或 `auth.json` 管理；
- endpoint 探测、远端模型发现或真实推理请求测试；
- 内置模型目录的增删；
- `defaultProvider`、`defaultModel`、`defaultThinkingLevel` 或 `enabledModels`；
- 保存后热刷新已经启动的 thread worker；
- 在 renderer 中提供完整 raw source 编辑器；
- 项目级 `.pi/models.json`，因为 Pi 当前不存在该配置层。

## 3. 现有边界

### 3.1 路由和 provider 生命周期

当前设置路由位于：

- `packages/desktop/src/renderer/src/app/app-router.tsx`；
- `packages/desktop/src/renderer/src/features/settings/settings-page.tsx`；
- `packages/desktop/src/renderer/src/features/settings/personalization-settings-page.tsx`。

`/settings` 不挂载 `DesktopProvider`，因此模型设置页不得 attach Pi session、初始化 chat runtime 或依赖 session control state。页面直接使用窄化的 `window.desktop.models` IPC API。

新增路由：

```text
/settings/models
```

`/settings` index 和未知 settings 子路由仍重定向到 `personalization`，不改变现有默认页。

### 3.2 配置权威来源

模型定义的权威来源保持为 `@earendil-works/pi-coding-agent`：

```text
built-in catalog
  + <agentDir>/models.json
  + extension registerProvider()
  -> ModelRegistry
```

设置页只编辑磁盘 `models.json` 部分。它可以读取用于辅助展示的 built-in provider 名称和已知 API 类型，但不得把最终 `ModelRegistry.getAll()` 反向序列化成文件，否则会把 built-in 和 extension 动态模型错误写入用户配置。

### 3.3 当前脏工作树

编写本规范时，以下文件已有未提交修改：

- `packages/desktop/src/renderer/src/features/settings/settings-page.tsx`；
- `packages/desktop/src/renderer/src/styles/layout.css`；
- 其他 Desktop layout/runtime 文件。

实施时必须增量修改并保留现有 resize/layout 行为，不得恢复或覆盖这些改动。

## 4. 产品信息架构

### 4.1 设置菜单

在“个性化”下增加：

```text
模型
```

使用 Lucide per-icon ESM 导入，建议图标为 `box`、`blocks` 或 `cpu` 中与现有视觉最一致的一项。禁止从 `lucide-react` barrel 导入。

菜单顺序：

```text
返回聊天
────────
个性化
模型
```

### 4.2 页面布局

模型设置是高密度操作页面，采用主从布局，不使用营销式卡片，也不把 card 嵌套在 card 中。

```text
页面标题 / 文件状态 / Reload / Save
├─ Provider 列表
│  ├─ 搜索
│  ├─ Add provider
│  └─ provider rows
└─ Provider detail
   ├─ 连接
   ├─ 模型
   ├─ 模型覆盖
   └─ 兼容性
```

宽屏使用 provider list + detail 两列。小窗口改为单列：选择 provider 后进入 detail，提供返回列表的图标按钮。固定工具栏和行控件必须有稳定尺寸，长 provider/model ID 换行或截断并提供 tooltip，不得撑破布局。

顶部命令：

- Reload：图标按钮，tooltip 为“重新载入”；
- Save：`Save` 图标加“保存”，仅 dirty 且 valid 时启用；
- Add：`Plus` 图标按钮；
- Delete：`Trash2` 图标按钮，进入确认对话框；
- 不使用每键自动保存。

### 4.3 Provider 列表

每一行显示：

- provider key；
- 可选 display name；
- custom model 数量；
- built-in override、custom provider 或 Radius OAuth 类型；
- error/warning 状态。

Provider key 是 JSON object key，也是运行时 identity。重命名必须作为显式操作处理，并校验新 key 非空且不与其他 provider 冲突。

“添加 provider”支持：

- 从内置 provider 列表选择并创建 override；
- 输入自定义 provider key；
- 不自动填入 API key；
- 可以选择常用 API 模板，但保存前仍由 Pi validator 决定是否合法。

### 4.4 Provider detail

#### 连接

字段：

- `name`；
- `baseUrl`；
- `api`；
- `oauth`，当前仅支持 `radius`；
- `apiKey`；
- `authHeader`；
- provider headers。

`api` 使用可输入 combobox：提供当前 Pi 支持 API 的建议值，但不把 UI 枚举当成 validator。扩展可能注册额外 API，用户必须能保留已有非建议值。

`apiKey` 作为普通受控字符串进入 renderer，并使用 `input type="password"` 展示。输入值可以是 literal、`$ENV` expression 或 `!command`，Desktop 不对其做脱敏、opaque token 转换或 replace-only 限制。Password input 只负责默认遮挡屏幕文本，不构成额外安全边界。用户把非空值清空时，draft normalization 删除可选的 `apiKey` property，不能把 `""` 写入文件，因为 Pi schema 要求已存在的 `apiKey` 至少一个字符。

Header 使用可增删的 key/value rows，value 作为普通受控字符串展示和保存。

#### 模型

模型列表显示：

- `id`；
- `name`；
- API；
- reasoning；
- context window；
- max output；
- text/image capabilities；
- validation state。

Model detail 覆盖当前 `ModelDefinitionSchema`：

- `id`；
- `name`；
- `api`；
- `baseUrl`；
- `reasoning`；
- `thinkingLevelMap`；
- `input`；
- `cost` 和 tiers；
- `contextWindow`；
- `maxTokens`；
- `headers`；
- `compat`。

布尔值使用 toggle/checkbox；输入能力使用 checkbox group；API 使用 combobox；数值使用 number input，不使用自由文本后再隐式转换。

`thinkingLevelMap` 固定显示 `off/minimal/low/medium/high/xhigh/max`。每级使用三态控件：

- inherited/omitted；
- supported，输入 provider value；
- unsupported，对应 `null`。

Cost 显示 input/output/cache read/cache write。Tier 是可排序列表，每项包含 `inputTokensAbove` 和完整四项费率。保存前校验阈值为有限非负数且不重复；最终合法性仍以 Pi validator 为准。

删除 custom model 的确认文案必须区分两种结果：

- 普通 custom provider：删除后模型不再由该文件定义；
- 与 built-in `(provider,id)` 冲突：动作名为“移除自定义覆盖”，删除后恢复 built-in 模型，而不是彻底删除该模型。

#### 模型覆盖

`modelOverrides` 以 model ID 为 key，编辑当前 `ModelOverrideSchema`：

- `name`；
- `reasoning`；
- `thinkingLevelMap`；
- `input`；
- partial `cost`；
- `contextWindow`；
- `maxTokens`；
- `headers`；
- `compat`。

Override 不创建模型。UI 可以用 effective catalog 提供 ID suggestions，但必须允许保留或输入未知 ID，因为扩展可能在运行时注册对应模型。

#### 兼容性

根据 provider/model 的 effective `api` 展示对应 controls。当前 schema 中所有字段都必须有结构化控件，包括：

- Anthropic Messages compatibility；
- OpenAI Completions compatibility；
- OpenAI Responses compatibility；
- OpenRouter routing；
- Vercel AI Gateway routing；
- chat template kwargs；
- session affinity；
- cache control 和 long retention；
- tool/reasoning capability flags。

复杂 list/map 使用 key-value editor、tag list、segmented control 或 select，不降级成整个对象的 raw JSON textarea。

当前 schema 之外的未来字段不允许 renderer 修改，但必须由 main 在保存时无损保留，并在对应 section 显示“存在当前版本无法编辑的字段”状态。

## 5. 页面状态模型

页面至少具有以下状态：

```text
loading
missing
ready-clean
ready-dirty-valid
ready-dirty-invalid
source-invalid
saving
saved
conflict
read-error
write-error
externally-changed-clean
externally-changed-dirty
```

行为：

- `loading`：显示稳定 skeleton，编辑和保存不可用；
- `missing`：以空 `{ providers: {} }` draft 展示，浏览页面不创建文件；
- `ready-clean`：允许编辑，保存 disabled；
- `ready-dirty-valid`：保存 enabled；
- `ready-dirty-invalid`：保留 draft，显示 inline diagnostics，保存 disabled；
- `source-invalid`：不把无效文件投影成空配置，不允许表单覆盖；提供重新载入和“在外部编辑器打开”；
- `saving`：阻止重复提交和删除；
- `saved`：使用 main 返回的新 snapshot/revision 重建 baseline；
- `conflict`：保留本地 draft，提供“查看磁盘版本”和“放弃本地修改并重新载入”，不得自动覆盖；
- read/write error：保留可恢复状态和具体错误；
- clean 时检测到外部修改可自动 reload；dirty 时转为 conflict warning。

外部修改检测采用显式 polling 合同：页面可见时每 5 秒调用一次 `getConfigRevision()`，窗口重新获得 focus 时立即检查。Clean 且 revision 改变时读取新 snapshot；dirty 时只进入 conflict warning，不替换 local draft。页面 hidden 或 unmount 后停止 timer。

Revision check 必须 single-flight；timer 在前一次 promise settle 后再调度，focus 检查复用当前 in-flight promise。每次请求捕获 page generation、baseline revision 和 draft generation；save/reload、任何 draft mutation、hidden 或 unmount 都推进相应 generation。响应返回时只在三者仍匹配时生效，否则作为 stale response 丢弃，不能覆盖新 baseline 或产生错误 conflict。

离开 settings route 或点击返回聊天时，使用 React Router blocker 和现有 `ConfirmDialog`。窗口关闭、系统退出和 main 拦截的 renderer reload 不能异步等待 React dialog，因此采用 Electron main 原生确认框：renderer 通过 `setEditorDirty()` 同步 dirty 状态，main 在 close/reload 前询问“放弃未保存的模型配置吗？”，确认后只放行当前动作一次。不得同时触发 native 和 React 两个确认框。

## 6. 共享 IPC 合约

模型配置使用独立 contract，不复用 session `ModelOption`。建议新增：

```text
packages/desktop/src/shared/models-config-contracts.ts
```

不得创建 re-export barrel。Desktop contract 通过 type-only import 复用 Phase 0 从 coding-agent 公共入口导出的配置类型，不复制 schema。

### 6.1 Draft DTO 与 metadata

```ts
import type {
  ModelsChatTemplateKwarg,
  ModelsCompatWithoutFreeMaps,
  ModelsConfigMetadata,
  ModelsModelDefinition,
  ModelsModelOverride,
  ModelsProviderConfig,
} from "@earendil-works/pi-coding-agent";

export interface ModelsMapEntryDraft<T> {
  key: string;
  value: T;
  origin?: { parentPath: readonly (string | number)[]; key: string };
}

export interface ModelsCompatDraft {
  config: ModelsCompatWithoutFreeMaps;
  chatTemplateKwargs?: ModelsMapEntryDraft<ModelsChatTemplateKwarg>[];
}

export interface ModelsProviderDraft {
  key: string;
  origin?: { providerKey: string };
  config: Omit<ModelsProviderConfig, "models" | "modelOverrides" | "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
  models: ModelsModelDraft[];
  modelOverrides: ModelsModelOverrideDraft[];
}

export interface ModelsModelDraft {
  origin?: { providerKey: string; modelIndex: number };
  config: Omit<ModelsModelDefinition, "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}

export interface ModelsModelOverrideDraft {
  modelId: string;
  origin?: { providerKey: string; modelId: string };
  config: Omit<ModelsModelOverride, "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}
```

`ModelsProviderConfig.apiKey` 和所有 header value 是 raw string。Optional property 以省略表示未配置，不能使用 `undefined` 作为需要跨 structured clone 的业务值。`models` 保持文件数组顺序；`modelOverrides` 在 DTO 中转换为有稳定 key 的数组，保存时恢复成 object。

所有允许自由 key 的 map 都转换为 `ModelsMapEntryDraft[]`，当前包括 provider/model/override headers 和 `compat.chatTemplateKwargs`。每个 entry 的 origin 指向原 parent JSON path 与 key，main 才能区分 rename 和 delete+add，并判断附属注释是否需要二次确认。固定 key object（例如 routing 字段）保持普通 object。未来 schema 新增自由 key map 时，Phase 0 parser DTO 和 Desktop draft adapter 必须同步增加 entry-array 投影；不得直接把可重命名 map 留成 `Record`。

Metadata 只包含 coding-agent built-in catalog 和已知 API，不加载 project extension，也不创建 session。Custom provider/model 已在 draft 中；extension model ID 仍允许自由输入。UI 中“内置 provider”“恢复 built-in”和 model override suggestions 只能使用该 metadata，不把它称为完整 effective catalog。

### 6.2 Snapshot

```ts
export interface ModelsConfigSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  sourceState: "missing" | "valid" | "invalid";
  providers: ModelsProviderDraft[];
  metadata: ModelsConfigMetadata;
  diagnostics: ModelsConfigDiagnostic[];
  preservedUnknownPaths: Array<readonly (string | number)[]>;
  activeSessionsRefreshed: false;
}

export interface ModelsConfigDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: readonly (string | number)[];
  message: string;
}
```

`revision` 是原始 bytes 的 SHA-256。missing 文件使用固定 sentinel，不使用时间戳。`sourceState === "invalid"` 时 `providers` 必须是空数组，避免 renderer 把部分 parse 结果当成可保存 draft；metadata 和 diagnostics 仍返回。

Diagnostic path 使用 segment array，不能用点分字符串作为 identity，因为 provider/model/header key 本身可能包含点、斜杠或冒号。Main 必须校验每个 origin 确实存在于 expected revision 对应文档，且 origin 在一次 save request 中最多被引用一次。

### 6.3 Save request/result

```ts
export interface SaveModelsConfigInput {
  expectedRevision: string;
  providers: ModelsProviderDraft[];
  confirmationToken?: string;
}

export type SaveModelsConfigResult =
  | { status: "saved"; snapshot: ModelsConfigSnapshot }
  | { status: "invalid"; diagnostics: ModelsConfigDiagnostic[] }
  | { status: "conflict"; current: ModelsConfigSnapshot }
  | {
      status: "confirmation-required";
      reason: "jsonc-comment-move";
      message: string;
      confirmationToken: string;
    };
```

只有 JSONC AST 层判断 rename 无法无损移动附属注释时返回 `confirmation-required`。Token 必须绑定 expected revision 和 normalized draft hash、短期有效且单次使用；用户确认后用完全相同的 draft 和 token 重试。Draft 或 revision 改变后旧 token 失效。

I/O、权限、锁超时和内部错误使用 rejected IPC promise。用户可修复的 invalid/conflict/confirmation-required 使用判别联合，保证 renderer 保留 draft。

### 6.4 Desktop API

在 `DesktopApi` 增加独立 namespace：

```ts
models: {
  getConfig(): Promise<ModelsConfigSnapshot>;
  getConfigRevision(): Promise<string>;
  saveConfig(input: SaveModelsConfigInput): Promise<SaveModelsConfigResult>;
  openConfigExternally(): Promise<void>;
  setEditorDirty(dirty: boolean): boolean;
}
```

Renderer 不传 path。main 只能操作构造 service 时注入的 `<agentDir>/models.json`。

Channels 建议：

```text
desktop:models:get-config
desktop:models:get-config-revision
desktop:models:save-config
desktop:models:open-config-externally
desktop:models:set-editor-dirty
```

## 7. coding-agent 公共配置 API

当前 `ModelsConfigSchema`、`ModelsConfig` 和 semantic validation 都是 `model-registry.ts` 私有实现。Desktop 不得复制 schema，也不得通过创建临时 `ModelRegistry` 来验证候选文件，因为 registry load/refresh 带 I/O 和全局 provider registration 副作用。

先在 coding-agent 提取：

```text
packages/coding-agent/src/core/models-config.ts
```

公共 API 至少包括：

```ts
export function parseModelsConfigSource(source: string, path?: string): ModelsConfigParseResult;
export function validateModelsConfigValue(value: unknown, path?: string): ModelsConfigValidationResult;
export function getModelsConfigMetadata(): ModelsConfigMetadata;

export interface ModelsConfigMetadata {
  knownApis: string[];
  builtInProviders: Array<{
    id: string;
    displayName: string;
    models: Array<{ id: string; name: string; api: string }>;
  }>;
}
```

Metadata DTO 必须是 structured-clone-safe plain data。Provider `id/displayName` 用于添加 built-in override；model `id/name/api` 用于冲突判断和 override suggestions；`knownApis` 是开放 combobox 的建议值，不是封闭 enum。

要求：

- parser 支持与 CLI 一致的 JSONC；
- schema error 和 semantic error 返回结构化 path/code/message；
- validator 是纯函数；
- 不执行 `$ENV` 或 `!command`；
- 不读取 auth；
- 不 register/reset API/OAuth providers；
- 导出 erasable TypeScript DTO，不使用 `enum`；
- metadata helper 只读取 built-in catalog，不加载 extension、auth 或 project resource；
- `ModelRegistry.loadCustomModels()` 改为复用同一 parser/validator；
- `packages/coding-agent/src/index.ts` 从公共入口导出 `ModelsProviderConfig`、`ModelsModelDefinition`、`ModelsModelOverride`、`ModelsCompatWithoutFreeMaps`、`ModelsChatTemplateKwarg`、metadata 类型与函数。

实施时必须同步核对 docs/schema 漂移。已知 `allowEmptySignature` 在文档和 AI 类型中存在，但当前 models schema 未明确声明；在 GUI 依赖 schema 前先修复并增加测试。

## 8. JSONC 与无损更新

Pi 当前接受带注释的 JSONC。`stripJsonComments + JSON.parse + JSON.stringify` 不能满足 round-trip，因此配置写路径必须使用成熟 JSONC AST 编辑库，不手写字符串替换。

依赖要求：

- 直接依赖固定精确版本；
- 使用 `npm install --ignore-scripts` 或 lockfile-only 安全流程；
- 依赖和 lockfile 视为代码审查范围；
- 不运行 lifecycle scripts；
- 在 spec 实施 PR 中说明选择理由和 AST edit 限制。

保真合同：

- 未修改 property 的 bytes、注释、顺序和未知字段保持不变；
- 新字段使用现有文件 indentation/EOL；
- 删除节点时允许删除直接附属于该节点的注释，但不得影响 sibling 注释；
- provider/model rename 视为 move，尽量携带节点内注释；无法无损 move 时先返回 `confirmation-required`，由 renderer 确认后携带绑定 token 重试，不能静默格式化整个文件；
- 整个文档不得因一次字段修改被重新排序或统一格式化；
- source-invalid 时不运行 AST edits。

## 9. Main ModelsConfigService

建议新增：

```text
packages/desktop/src/main/models/models-config-service.ts
```

### 9.1 构造和路径

`ModelsConfigService` 由 main 使用已解析的 `agentDir` 构造。target 固定为 `join(agentDir, "models.json")`。

要求：

- renderer 无法覆盖 target；
- 父目录创建为 `0700`；
- 新文件和 temp 使用 `0600`；
- existing 文件不是普通文件时拒绝；
- symlink target 默认拒绝，避免 renderer 间接编辑 agentDir 外文件；
- path 只作为只读展示返回。

### 9.2 Read

Read 流程：

1. 读取原始 bytes；
2. missing 映射为空配置，不创建文件；
3. 计算 revision；
4. 调用 coding-agent parser/validator；
5. 通过纯 metadata helper 读取 built-in provider、model 和 known API suggestions；
6. 建立带 origin identity 的 draft；
7. 将 `apiKey`、header value 和其他配置字段作为原始字符串装入 draft；
8. 标记 unknown paths；
9. 返回 snapshot。

读取、schema 检查和 UI 展示可以传递 `!command` 字符串，但不得执行它。

### 9.3 Save

Save 必须：

1. 进入进程内串行队列；
2. 获取跨进程 lock；
3. 在锁内重读 target 并计算 revision；
4. revision 不等于 `expectedRevision` 时返回 conflict；
5. 根据 origin identity 合并 unknown 字段与 renderer draft；
6. 拒绝伪造/重复 origin、重复 key 和非法 path；
7. 将清空的 optional `apiKey` property 规范化为省略；
8. 调用 coding-agent pure validator；
9. invalid 时不写盘；
10. 通过 JSONC AST edits 生成候选 source；
11. rename 无法无损移动附属注释且没有有效 token 时返回 `confirmation-required`，不写盘；
12. 有 token 时校验其 revision、draft hash、TTL 和 single-use 状态；
13. 再解析候选 source，确认语义等于预期 config；
14. 写同目录唯一 temp；
15. `fsync` temp、设置权限、atomic rename、`fsync` directory；
16. finally 删除残留 temp；
17. 返回重新读取的新 snapshot。

锁不能替代 revision。Pi CLI 或外部编辑器可能不遵守 Desktop lock，因此 save 时的 revision compare 是必须的。若平台无法提供严格 CAS，仍以“锁内重读 + 同目录 atomic rename”作为最小合同，并用 conflict 测试覆盖可观察竞态。

不创建自动 `.bak` 副本。原子写失败必须保留原文件。

### 9.4 日志

日志记录 path、revision 前缀、provider/model 数量、结果 code 和错误信息。正常保存不输出完整 source 或完整 IPC payload。

## 10. 保存后的运行时语义

保存成功后：

- Pi CLI 下次打开 `/model` 会 refresh 并看到新配置；
- Desktop 下一次 `getDraftConfig()` 会创建 fresh services 并看到新配置；
- 新启动的 thread worker 使用新配置；
- 已经运行的 thread worker 继续持有原 registry/model object；
- 不发送自动 model fallback；
- 不终止正在进行的请求；
- 不承诺 active session 的模型列表立即变化。

页面保存成功状态明确显示“新会话生效”。不在本阶段加入 sidecar refresh command。若未来需要热刷新，必须另写规范，定义当前模型被删除、认证消失、请求进行中和 control push 的行为。

## 11. Renderer 结构

建议文件：

```text
features/settings/models-settings-page.tsx
features/settings/models-settings-controller.ts
features/settings/models-settings-model.ts
features/settings/models-provider-list.tsx
features/settings/models-provider-form.tsx
features/settings/models-model-list.tsx
features/settings/models-model-form.tsx
features/settings/models-overrides-form.tsx
features/settings/models-compat-form.tsx
features/settings/models-api-key-field.tsx
features/settings/models-header-editor.tsx
features/settings/models-thinking-map-editor.tsx
features/settings/models-cost-editor.tsx
```

名称可在实施时收敛，但必须遵守：

- 一个 `.tsx` 最多一个 React component；
- 不在组件内部声明组件；
- 不创建 barrel；
- 纯 reducer、draft normalization 和 diagnostics mapping 放 `.ts`；
- route 文件只声明 route；
- feature 不把状态塞入全局 Desktop store；
- server snapshot 与 local draft 分离；
- expensive diagnostics/index 使用稳定 primitive dependency，避免每次输入重建整个页面；
- 大型 compat 子表单按 API 分支渲染，不把所有 provider controls 一次挂载。

模型设置样式进入 `styles/layout.css` 中明确的 settings/models ownership 区域，或新增由 `styles/index.css` 明确纳入 components layer 的 feature CSS。颜色只使用 token；状态使用 `data-state`/`data-tone`；禁止固定 palette 和无归属全局规则。

## 12. 校验和诊断

校验分两层：

### 12.1 Renderer 即时校验

只处理无副作用、低成本规则：

- 必填字段；
- provider/model/header key 重复；
- 数值是否为有限数；
- URL 输入的基础格式；
- `apiKey` 和 header value 是否为字符串；
- 空 `apiKey` 是否已规范化为 property omission；
- origin identity 是否只引用当前 snapshot 中的 entity。

即时校验用于快速反馈，但不是写盘权威。

### 12.2 Main/Pi 权威校验

权威校验覆盖：

- TypeBox schema；
- non-built-in provider 的 `baseUrl`；
- provider/model API 继承；
- context/max tokens 正数；
- compat 联合类型；
- cost/thinking map；
- coding-agent 后续新增 semantic rules。

Diagnostic path 映射到具体 field。无法映射的错误显示在页面级 error summary，并将焦点移动到 summary；summary item 可聚焦对应字段。

不执行网络请求，不解析 credential，不以“连接成功”作为保存条件。

## 13. 可访问性和交互

- Provider list 使用 listbox 或语义清晰的 navigation/list，不用不可聚焦 div；
- Tabs 使用 Radix Tabs；
- toggle/checkbox/select 使用已有 primitive 或 Radix；
- 图标按钮全部有 accessible name 和 tooltip；
- 删除确认初始焦点在取消按钮；
- error summary 使用 `role="alert"` 或 `aria-live="polite"`；
- inline error 通过 `aria-describedby` 关联字段；
- 保存中保持布局尺寸不变；
- keyboard 支持 Tab、Shift+Tab、Enter、Escape 和 list 上下方向键；
- focus-visible 不得被移除；
- forced-colors 和 reduced-motion 沿用现有 CSS 合同；
- 1024x680 下所有字段、按钮和长 ID 不重叠。

## 14. IPC 与进程边界

- BrowserWindow 继续使用 context isolation、sandbox 和 `nodeIntegration: false`；
- renderer 不读取文件系统、不接收任意 path 参数；
- preload 只做 typed invoke mapping，不实现文件或校验逻辑；
- main 对所有 IPC input 做 runtime 校验，不能只信 TypeScript；
- snapshot 直接包含 `apiKey`、header value 和 command string，renderer 用受控表单编辑；
- `setEditorDirty()` 只在 clean↔dirty transition、unmount 和成功保存时调用，并由 preload 使用 `ipcRenderer.sendSync`；main 在写入按 webContents 隔离的 dirty map 后设置同步返回值，确保调用返回时 native close/reload gate 已看到新状态；
- renderer 必须在产生 dirty 的同一个 input/action handler 中同步调用，不能放在 `useEffect` 或 transition 后；main 在 webContents destroyed 时清理状态；
- main 的窗口 close、系统 quit 和快捷键 reload 路径复用同一个 native confirm gate，确认后用一次性 bypass 防止递归拦截；
- 页面 load/validate 不执行 `!command`；
- `openConfigExternally()` 只打开固定 target；missing 时创建最小文件前必须先确认，或者打开 agentDir，不接受 renderer path；
- unknown properties 保留不代表执行它们；最终行为仍由 Pi schema/registry 决定。

## 15. 分阶段实施计划

### Phase 0：Pi 公共 parser/validator

涉及：

- 新增 `packages/coding-agent/src/core/models-config.ts`；
- 修改 `packages/coding-agent/src/core/model-registry.ts` 复用公共 parser；
- 修改 `packages/coding-agent/src/index.ts` 导出 API；
- 增加 parser/schema/semantic tests；
- 修复 `allowEmptySignature` 等已确认的 docs/schema 漂移；
- 如采用 JSONC AST 库，按依赖安全规则更新 package metadata 和 lockfile。

完成条件：Desktop 不需要复制 schema，也不需要临时 registry 即可纯解析和校验 candidate。

### Phase 1：Main service 与 IPC

涉及：

- 新增 `packages/desktop/src/main/models/models-config-service.ts`；
- 新增 `packages/desktop/src/shared/models-config-contracts.ts`；
- 修改 `packages/desktop/src/shared/channels.ts`；
- 修改 `packages/desktop/src/shared/desktop-api.ts`；
- 修改 `packages/desktop/src/preload/index.ts`；
- 修改 `packages/desktop/src/main/ipc.ts`；
- 修改 `packages/desktop/src/main/index.ts`，传入与 sidecar 相同的 `agentDir`，并接入 close/reload native confirm gate；
- 增加 service、IPC、preload 和 window dirty-guard focused tests。

完成条件：missing/valid/invalid 文件可读取，所有当前配置值可 round-trip，valid update 可原子保存，invalid/conflict 不写盘。

### Phase 2：基础页面和常用字段

涉及：

- 新增 `/settings/models` route；
- 在现有 settings menu 增加“模型”；
- 实现 provider CRUD；
- 实现 model CRUD；
- 实现基础 connection/input/cost/thinking controls；
- 实现 loading/dirty/invalid/saving/conflict/confirmation-required/error；
- 实现 focus + 5 秒 revision polling；
- 实现 route dirty guard、native window dirty 同步、删除确认和新会话生效状态；
- 增加 route/page/component tests 和 settings CSS。

完成条件：不依赖 raw JSON editor 即可完成常见 Ollama、LM Studio、vLLM 和 proxy 配置。

### Phase 3：完整当前 schema 覆盖

涉及：

- `modelOverrides`；
- provider/model/override headers；
- 所有当前 compat 字段；
- OpenRouter/Vercel routing；
- chat template kwargs；
- cost tiers；
- unknown-field preservation indicator；
- 大量模型和复杂配置性能测试。

完成条件：当前 `models.json` schema 中不存在只能通过 raw JSON textarea 修改的已知字段。

### Phase 4：Electron 验收和文档

- GUI smoke 覆盖 settings route；
- light/dark/system；
- 1440x920 和 1024x680；
- 真实 JSONC、comment、API key、header、unknown field 和外部 conflict；
- Pi CLI `/model` 与 Desktop 新草稿读取同一保存结果；
- 更新 Desktop docs 中设置能力说明。

## 16. 测试计划

### 16.1 coding-agent

新增 focused tests：

- missing/empty/valid JSONC；
- comments 和 trailing comma；
- schema diagnostic path；
- semantic validation；
- `allowEmptySignature`；
- unknown field policy；
- parse/validate 不执行 command；
- parse/validate 不 reset/register global provider；
- ModelRegistry 与 pure parser 对同一 source 给出一致结果。

### 16.2 ModelsConfigService

必须覆盖：

- missing 不创建文件；
- valid load；
- source-invalid；
- literal、environment expression、command 和 header value 原样进入 snapshot；
- API key 修改和 round-trip，清空后 property 被删除；
- provider/model/header rename 后配置值和 unknown 字段正确跟随；
- header 和 `chatTemplateKwargs` entry origin 可区分 rename 与 delete+add；
- 带附属注释的 provider/model/free-key-map rename 返回 confirmation-required，合法 token 重试成功，token 对其他 revision/draft 无效；
- forged origin 被拒绝；
- duplicate key；
- revision conflict；
- metadata wire shape 包含 provider `id/displayName`、model `id/name/api` 和 `knownApis`，且不加载 project extension；
- 同进程并发串行；
- lock timeout；
- external writer race；
- temp cleanup；
- write failure 保留原文件；
- `0600` file 和 `0700` parent；
- symlink/non-file rejection；
- comments/order/EOL/unknown fields 保留；
- candidate 二次 parse；
- 正常保存不输出完整 source/payload。

### 16.3 IPC/preload

- channel mapping；
- renderer 无 path 参数；
- result union round trip；
- thrown I/O error 保持 message；
- API key/header value 可通过 IPC round-trip；
- config revision polling 映射；
- editor dirty 使用同步 IPC，返回前 main 已更新按 webContents 隔离的状态；
- 输入后立即 native close/reload 仍触发确认，destroyed 后 dirty 状态清理；
- preload bridge 暴露 `models` namespace。

### 16.4 Renderer

- `/settings/models` 可进入且菜单 active；
- `/settings` 默认仍是 personalization；
- loading/missing/clean/dirty/invalid/saving/saved；
- source-invalid；
- conflict 保留 draft；
- clean polling 自动 reload，dirty polling 只提示 conflict；
- polling single-flight；save/reload/edit/unmount 后迟到响应被 generation 丢弃；
- confirmation-required 使用同 draft/token 重试；
- reload-discard；
- provider/model CRUD；
- built-in override 删除文案；
- header/chatTemplateKwargs rename 与 delete+add 产生不同 draft origin；
- API key 使用 `input type="password"` 并可直接编辑；
- unknown field indicator；
- route 使用 React dialog，close/reload 使用单一 main native guard；
- keyboard/focus/ARIA；
- 长 ID、大量 model 和窄窗口布局。

## 17. 验证命令

修改测试文件后，从 `packages/desktop` 或对应 package 运行具体 Vitest：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

代码实现完成后：

```bash
node scripts/verify-desktop-renderer-boundaries.mjs
npm --prefix packages/desktop run typecheck
npm run check

git diff --check
```

不得默认运行根 `npm test`、完整 Vitest 或 `npm run build`。依赖变更使用 `npm install --ignore-scripts` 或 `npm install --package-lock-only --ignore-scripts`，并审查 lockfile。

Electron 手工验收至少覆盖：

- `#/settings/models` route/provider 生命周期；
- settings 页面不 attach session；
- 创建 Ollama custom provider/model；
- 编辑 built-in provider override；
- API key 以 password input 展示并可直接修改；
- literal、environment expression、command 和 header value 正确 round-trip；
- JSONC comment 和 unknown field 保留；
- 外部编辑器修改后的 conflict；
- 保存后新草稿看到新模型；
- active session 不被中断；
- light/dark/system 和两个最低视口。

## 18. 验收标准

全部满足才视为完成：

1. 设置菜单存在“模型”，`#/settings/models` 可直接访问。
2. 进入设置不创建或 attach Pi session。
3. 页面操作实际 `<agentDir>/models.json`，支持 `PI_CODING_AGENT_DIR`。
4. 当前 Pi schema 的 provider、model、modelOverrides、cost、thinking map、headers 和 compat 都有结构化控件。
5. Renderer 直接获得和编辑 `apiKey`、command string 与 header value；API key 控件使用 `input type="password"`。
6. Desktop 与 ModelRegistry 使用同一公共 parser/schema/semantic validator。
7. 页面读取和保存验证不执行 `!command`，不访问网络。
8. 未编辑注释、顺序、格式、配置值和 unknown fields 保留。
9. 保存使用进程内队列、跨进程 lock、expected revision 和同目录 atomic replace。
10. Invalid/conflict/write failure 不破坏原文件，也不丢失 renderer draft。
11. 新文件权限为 `0600`，父目录为 `0700`；特殊文件和 symlink 被拒绝。
12. Built-in provider/API/model suggestions 来自无 session 副作用的 metadata contract，extension ID 仍可自由输入。
13. 页面通过 focus + 5 秒 revision polling 检测外部修改；请求 single-flight，generation 防止迟到响应覆盖 save/reload/edit 后状态；clean 自动 reload，dirty 保留 draft。
14. Route 离开使用 React dialog；dirty transition 通过同步 IPC 在返回前更新 main；窗口 close、系统 quit 和 renderer reload 使用 main 原生确认且只弹一次。
15. JSONC rename 可能影响附属注释时，必须通过绑定 revision/draft 的 confirmation token 二次保存。
16. 保存只声明“新会话生效”，不会中断或静默修改 active session。
17. 路由、service、IPC、preload、renderer 状态和进程边界有 focused tests。
18. Renderer boundary、Desktop typecheck、根 `npm run check` 和 `git diff --check` 通过。
19. Electron 在 light/dark/system、1440x920 和 1024x680 下无文本溢出、控件重叠或焦点缺失。

## 19. 后续扩展

以下能力必须单独设计，不应顺手加入本实施：

- 默认模型与 thinking 设置页；
- `auth.json`/OAuth 凭据管理；
- provider endpoint/model discovery；
- active worker registry refresh；
- config file watch push；
- project-scoped models config；
- 导入/导出 provider template；
- 团队策略和只读 managed config。
