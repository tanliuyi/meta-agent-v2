# Desktop 凭据设置规范

状态：Proposed
最后更新：2026-07-21

## 1. 目标

在 Desktop 设置中新增"凭据"菜单和 `#/settings/auth` 子路由，用结构化界面编辑 Pi CLI 与 Desktop 共同使用的 `auth.json`。

本规范中的文件名统一指 `auth.json`。默认路径是 `~/.pi/agent/auth.json`，但实现必须使用 Desktop main 已解析的 `agentDir`，完整支持 `PI_CODING_AGENT_DIR`，不得在 renderer 中拼接 home 路径。

最终能力包括：

- 查看当前凭据文件状态、实际路径、已配置的 provider 数量；
- 新增、修改、删除 API key 凭据（含 provider 范围的 env 覆盖）；
- 编辑 API key `key` 字段（支持 literal、`$ENV` 表达式、`!command`）；
- 在写盘和使用前对 `key` 做客户端语法校验（command 格式、env 模板合法性），但不执行 `!command` 或访问网络；
- 将 OAuth 凭据以只读方式展示（由 Pi TUI `/login` 管理）；
- 为每个 provider 显示关联的环境变量和凭据来源；
- 保留未编辑的 JSON 格式、JSONC 注释和未来未知字段；
- 检测外部修改，禁止静默 last-write-wins；
- 使用锁和原子替换安全写入凭据。

该页面编辑的是凭据文件，不是当前会话的模型选择器，也不管理 `settings.json` 中的默认 provider。

## 2. 非目标

首期不实现：

- `/login`、OAuth 登录流程或 token 刷新（仍由 Pi TUI 完成）；
- `models.json` 中 `apiKey` 字段与 `auth.json` 的同步或迁移；
- 凭据有效性校验（不做真实 API 调用或 endpoint 探测）；
- 保存后自动通知 active session worker 重载凭据；
- 在 renderer 中提供完整 raw source 编辑器；
- 项目级 `.pi/auth.json`，因为 Pi 当前不存在该配置层；
- CLI `--api-key` 运行时覆盖的 GUI 管理；
- 凭据导入/导出模板。

## 3. 现有边界

### 3.1 路由和 provider 生命周期

当前设置路由位于：

- `packages/desktop/src/renderer/src/app/routes/settings.tsx`；
- `packages/desktop/src/renderer/src/app/routes/settings.index.tsx`；
- `packages/desktop/src/renderer/src/app/routes/settings.personalization.tsx`；
- `packages/desktop/src/renderer/src/app/routes/settings.models.tsx`。

`/settings` 不挂载 `DesktopProvider`，因此凭据设置页不得 attach Pi session、初始化 chat runtime 或依赖 session control state。页面直接使用窄化的 `window.desktop.auth` IPC API。

新增路由：

```text
/settings/auth
```

`/settings` index 和未知 settings 子路由仍重定向到 `personalization`，不改变现有默认页。

### 3.2 配置权威来源

凭据定义的权威来源保持为 `@earendil-works/pi-coding-agent` 的 `AuthStorage`：

```text
<agentDir>/auth.json
  + CLI --api-key runtime override
  + environment variables (OPENAI_API_KEY, etc.)
  + models.json apiKey
  -> AuthStorage.getApiKey()
```

设置页只编辑磁盘 `auth.json` 部分。它可以读取用于辅助展示的 known provider 元数据（来自 `models.json` built-in catalog），但不得把最终 `ModelRegistry.getAll()` 或 `AuthStorage.getAll()` 反向序列化成文件。

环境变量和 `models.json` 中 `apiKey` 字段的凭据来源在 UI 中以 informational-only 方式展示，不在本页编辑。`auth.json` 中已定义的 provider 不因 missing env var 或 missing `models.json` 定义而产生 diagnostic；Diagnostic 仅用于 auth.json 自身的 schema 违反。

### 3.3 与 models.json 的关系

`auth.json` 和 `models.json` 是两个独立文件，拥有独立的读写服务、IPC 通道和设置页。

交叉点：
- `auth.json` 中未发现的 provider 可以是 custom provider（定义在 `models.json` 中），也可能是 OAuth-only provider。凭据设置 UI 不验证 provider 是否存在于 `models.json`，因为 provider 可能来自 extension；
- `models.json` 的 `apiKey` 字段是 inline credential，优先级低于 `auth.json`。凭据设置页在 provider detail 中展示 `models.json` 的 `apiKey` 来源为 informational label，但不在此页编辑。

### 3.4 当前脏工作树

编写本规范时，`models-settings-spec.md` Phase 2-4 可能仍在实施中。凭据设置的实施时机由 models 页完成度决定。如果 models 页尚未完成，凭据设置可复用其 IPC/preload 基建模式，但应作为独立 deliverable 实施。

## 4. CLI 兼容性和互操作

### 4.1 同一个文件

Desktop 凭据设置页和 Pi CLI 操作的是**同一个物理文件**：

```text
<agentDir>/auth.json
默认: ~/.pi/agent/auth.json
可通过: PI_CODING_AGENT_DIR 环境变量覆盖
```

不做任何路径转换或别名。Desktop 保存后，`pi --model anthropic/claude-sonnet-4-5` 直接使用同一凭据；Pi CLI 的 `/login` 结果在 Desktop 重新载入后立即可见。

### 4.2 同一数据格式

auth.json 的 JSON schema 由 `@earendil-works/pi-coding-agent` 的 `AuthStorage` 定义，Desktop 不引入私有格式：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": {
    "type": "api_key",
    "key": "$OPENAI_API_KEY",
    "env": { "OPENAI_API_KEY": "sk-..." }
  },
  "github-copilot": {
    "type": "oauth",
    "accessToken": "gho_...",
    "refreshToken": "ghr_...",
    "expires": 1730000000000
  }
}
```

Desktop 的 `AuthConfigService` 和 Pi CLI 的 `FileAuthStorageBackend` 使用相同的 JSON 结构。不存在 desktop-only 或 cli-only 字段。

### 4.3 Key 解析语义一致

API key 的 `key` 字段支持 literal、`$ENV` 表达式、`!command` 三类值。Desktop 只负责存储 raw string，**不自行解析**。运行时解析统一由 Pi 的 `resolveConfigValue()` 完成：

| 存入 Desktop 的值 | Pi 运行时的解析结果 |
|---|---|
| `sk-ant-...` | 字面量 `sk-ant-...` |
| `$ANTHROPIC_API_KEY` | 进程环境变量 `ANTHROPIC_API_KEY` 的值，或 `env` 中覆盖的值 |
| `!security find-generic-password -ws 'anthropic'` | 执行该 macOS keychain 命令，取 stdout |
| `$$literal-dollar-prefix` | 字面量 `$literal-dollar-prefix` |

Desktop 的 key syntax validation（第 8.4 节）只检查语法合法性（`!` 后是否有 command、`$` 括号是否匹配），**不执行** `!command`，**不展开** `$ENV` 的值。这确保了 Desktop edits 不会触发意外的命令执行。

### 4.4 OAuth 凭据的读写

OAuth 凭据由 Pi TUI `/login` 流程创建，由 `AuthStorage.refreshOAuthTokenWithLock()` 自动刷新。Desktop 的读写策略：

- **读取**：Main 在 snapshot 时将 OAuth credential 脱敏为摘要（`providerName`、`expires`、`expired`），不暴露 `accessToken` 和 `refreshToken` 给 renderer；
- **写入**：Desktop 不修改 OAuth credential 字段（renderer 根本拿不到这些 token）；
- **删除**：Desktop 可以移除整个 provider entry，等效于 Pi CLI `/logout`；
- **刷新**：Desktop 不触发 token 刷新，由 Pi CLI 或 session worker 的 `getApiKey()` 负责。

Desktop 保存 `auth.json` 时，OAuth 凭据从内存中的 `AuthStorage` 原样复制到序列化输出，不做任何修改。

### 4.5 文件锁互斥

Desktop 和 Pi CLI 可能同时运行（例如 Desktop 里有一个 active session worker，用户在终端又开了 `pi`）。两者都使用 `proper-lockfile` 对 `auth.json` 加锁：

- `FileAuthStorageBackend`：Pi CLI 端，带 10 次重试的同步锁；
- `AuthConfigService`：Desktop 端，带 6 次重试 + stale 30s 的异步锁；

两者都使用相同的 `proper-lockfile` 协议，不会出现一方绕过锁直接写入的情况。

### 4.6 兼容性验证清单

实施完成后应执行以下验证：

| 场景 | 预期结果 |
|---|---|
| Desktop 保存 API key → Pi CLI 使用该 provider | `pi --model <provider>/<model>` 正常启动 |
| Pi CLI `/login` → Desktop reload → 显示 OAuth 凭据 | 凭据列表出现 OAuth provider，显示过期时间 |
| Desktop 删除 API key provider → Pi CLI 找不到凭据 | `pi --list-models` 中该 provider 不再标记为已认证 |
| Desktop 编辑 `key` 为 `$ENV_VAR` → Pi CLI 消费 | Pi 正确读取 env var 的值 |
| Desktop 保存 + Pi CLI 并发写入 | 一方获得 lock，另一方收到 revision conflict |
| Pi CLI `/model` 切换 → Desktop 中同一 provider 仍可用 | Desktop session 使用同一 `auth.json` 凭据 |
| Desktop 添加新 provider `foo` + 同时 Pi CLI 添加 `bar` | 两个保存串行执行，a.json 最终包含两者 |

## 5. 产品信息架构

### 5.1 设置菜单

在"模型"下增加：

```text
凭据
```

使用 Lucide per-icon ESM 导入，建议图标为 `key`、`shield` 或 `lock` 中与现有视觉最一致的一项。禁止从 `lucide-react` barrel 导入。

菜单顺序：

```text
返回聊天
────────
个性化
模型
凭据
```

### 5.2 页面布局

凭据设置是管理类页面，采用主从布局，不使用营销式卡片。

```text
页面标题 / 文件状态 / 外部打开 / Reload / Save
├─ Provider 凭据列表
│  ├─ 搜索
│  ├─ Add provider
│  └─ provider rows（状态图标 + provider key + credential type + 凭据来源）
└─ Provider credential detail
   ├─ 类型标签（API Key / OAuth）
   ├─ API Key：key 字段（input type="password"）
   ├─ API Key：provider env 覆盖 key-value table
   └─ OAuth：只读摘要（登录提供商、过期时间）
```

宽屏使用 provider list + detail 两列。小窗口改为单列：选择 provider 后进入 detail，提供返回列表的图标按钮。

顶部命令：

- Reload：图标按钮，tooltip 为"重新载入"；
- Save：`Save` 图标加"保存"，仅 dirty 且 valid 时启用；
- 不存在 Add 和 Delete 的 toolbar 按钮，CRUD 动作都在 list 和 detail 面板内部。

### 5.3 Provider 凭据列表

每一行显示：

- provider key；
- 凭据类型标签（API Key / OAuth / 未配置）；
- 凭据来源（auth.json / 环境变量 / models.json / CLI flag）；
- API key 预览（脱敏显示：前 6 字符 + `...` + 后 4 字符；OAuth 显示过期时间）；
- error 状态指示（如 `auth.json` 中存在但 key 语法无效）。

凭据类型标签使用不同颜色/样式区分：
- API Key：灰/蓝标签 `API Key`；
- OAuth：紫标签 `OAuth`（如已过期则在标签旁加橙色 warning 图标）；
- 已配置（来自 env / `--api-key` / `models.json` 但不在 `auth.json` 中）：虚线边框标签 `环境变量` / `CLI` / `models.json`，表示只读。

"添加 provider" 入口位于列表底部：
- 从 built-in provider 列表选择（使用 `models.json` metadata 的 builtInProviders）；
- 或输入自定义 provider key；
- 新 provider 默认类型为 API key。

Provider key 是 JSON object key，也是运行时 identity。重命名必须作为显式操作处理，并校验新 key 非空且不与其他 provider 冲突。

### 5.4 Credential detail

#### API Key credential

字段：

- `key` — 必填。支持 literal、`$ENV` 表达式、`!command` 和 `$$escape` / `$!escape`；
- `env` — 可选。provider 范围的 key-value map，用于覆盖凭据解析时的环境变量。

`key` 字段行为：

- 使用 `input type="password"` 展示，用户可切换可见性（eye toggle）；
- 输入值可以是 literal（如 `sk-ant-...`）、`$ENV_VAR`、`${ENV_VAR}`、`!command`、`$$literal-dollar` 或 `$!literal-bang`；
- Desktop 不区分 literal / env / command 输入模式，不提供分割控件；所有格式作为 raw string 存储在 `auth.json` 中，由 Pi `resolveConfigValue()` 在消费时解析；
- 客户端 pre-submit 校验：
  - `!` 前缀的值必须以 `!` 开头且后跟非空 command 字符；`!!` 非法；
  - `$` 前缀的值不能为 bare `$`，`$ENV` 模板中括号必须匹配；
  - 字面量可以为空字符串（保存时 `key` property 必须非空以通过 Pi 的 schema 要求）；
  - 不执行 command，不解析 env 引用内容。

`env` 字段行为：

- 可增删 key-value rows；
- key 必须是有效 shell 变量名（`/^[A-Z_][A-Z0-9_]*$/i`），value 为普通受控字符串；
- 空 map 在保存时省略 `env` property；
- Pi 在 `getApiKey()` 时将 `env` 作为 provider-scoped 环境注入 `resolveConfigValue`，优先于进程环境。

#### OAuth credential

OAuth 凭据为只读展示：

- 展示 provider 显示名、登录类型（如 Claude Pro/Max、ChatGPT Plus/Pro）；
- 展示 token 过期时间（绝对时间 + 相对剩余时间）；
- 提供"移除"按钮，等效于 Pi TUI `/logout`；
- 不提供编辑 OAuth token 字段（由 `/login` 流程管理）；
- OAuth 凭据经 Desktop 保存后，Pi TUI `/login` 刷新时可正确读写。

OAuth 凭据在 Pi 中通过 `getOAuthApiKey()` 消耗，刷新由 `AuthStorage.refreshOAuthTokenWithLock()` 处理。Desktop 页面不触发刷新。

### 5.5 已知 provider 列表

设置页从 `models.json` metadata 获取 built-in provider 名称用于：
1. "添加 provider"时的建议列表；
2. Provider detail 中的显示名（如 provider key 为内置 key 则显示 displayName）；
3. 显示推荐的 env var 名称（如 `ANTHROPIC_API_KEY`）。

Provider 的 env var 映射来自 `@earendil-works/pi-ai/compat` 的 `findEnvKeys()`，不是 hard-coded。

未知 provider key（extension 注册或在 `models.json` 中自定义）仍允许编辑凭据。

## 6. 页面状态模型

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
```

行为：

- `loading`：显示稳定 skeleton，编辑和保存不可用；
- `missing`：以空 `{}` draft 展示，浏览页面不创建文件；
- `ready-clean`：允许编辑，保存 disabled；
- `ready-dirty-valid`：保存 enabled；
- `ready-dirty-invalid`：保留 draft，显示 inline diagnostics，保存 disabled；
- `source-invalid`：由于 `auth.json` 格式远简单于 `models.json`，source-invalid 仅当 JSON 解析失败时出现。提供重新载入和"在外部编辑器打开"按钮，不提供 structured 编辑；
- `saving`：阻止重复提交；
- `saved`：使用 main 返回的新 snapshot/revision 重建 baseline，UI 反馈"已保存 · 新会话生效"；
- `conflict`：保留本地 draft，提供"查看磁盘版本"和"放弃本地修改并重新载入"，不得自动覆盖；
- read/write error：保留可恢复状态和具体错误。

外部修改检测采用显式 polling 合同：页面可见时每 5 秒调用一次 `getConfigRevision()`，窗口重新获得 focus 时立即检查。Clean 且 revision 改变时读取新 snapshot；dirty 时只进入 conflict warning，不替换 local draft。页面 hidden 或 unmount 后停止 timer。

Revision check 必须 single-flight；timer 在前一次 promise settle 后再调度，focus 检查复用当前 in-flight promise。每次请求捕获 page generation、baseline revision 和 draft generation；save/reload、任何 draft mutation、hidden 或 unmount 都推进相应 generation。响应返回时只在三者仍匹配时生效，否则作为 stale response 丢弃，不能覆盖新 baseline 或产生错误 conflict。

离开 settings route 或点击返回聊天时，使用 React Router blocker 和现有 `ConfirmDialog`。窗口关闭、系统退出和 main 拦截的 renderer reload 不能异步等待 React dialog，因此采用 Electron main 原生确认框：renderer 通过 `setEditorDirty()` 同步 dirty 状态，main 在 close/reload 前询问"放弃未保存的凭据配置吗？"，确认后只放行当前动作一次。不得同时触发 native 和 React 两个确认框。

跨页 dirty guard：`models` 和 `auth` 两个 settings page 各自维护独立的 `setEditorDirty()` / `removeDirty()` 生命周期。main 的 `DirtyGuard` 已按 webContents 隔离，两个路由组件各自在 mount 时注册、unmount 时移除。跨路由切换的 React dialog 由各自页面的 blocker 处理，main 只在 window close / system quit / renderer reload 时检查该 webContents 下所有注册来源的 OR 结果。

## 7. 共享 IPC 合约

凭据配置使用独立 contract，不复用 session 或 models 的合约。

新增：

```text
packages/desktop/src/shared/auth-config-contracts.ts
```

不得创建 re-export barrel。Desktop contract 通过 type-only import 复用 `@earendil-works/pi-coding-agent` 导出的 `ApiKeyCredential`、`OAuthCredential`、`AuthCredential` 类型，不复制 schema。

### 7.1 Draft DTO 与 metadata

```ts
import type {
  ApiKeyCredential,
  AuthCredential,
  OAuthCredential,
} from "@earendil-works/pi-coding-agent";

export type AuthProviderDraft = {
  /** Provider key (object key in auth.json). Required; must be non-empty. */
  key: string;
  /** Origin provider key if this draft was loaded from disk (for rename detection). */
  origin?: string;
  /** API key credential draft (only one of apiKey/oauth present at a time). */
  apiKey?: {
    key: string;
    env?: AuthEnvEntry[];
  };
  /** OAuth credential (read-only from Desktop perspective). */
  oauth?: {
    /** Display name of the OAuth provider (from Pi OAuth registry). */
    providerName: string;
    /** ISO string of token expiry. */
    expires: string;
    /** Whether the token is currently expired. */
    expired: boolean;
  };
};

export type AuthEnvEntry = {
  key: string;
  value: string;
  origin?: string;
};

export interface AuthConfigDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: readonly (string | number)[];
  message: string;
}

export interface AuthProviderInfo {
  /** Provider key used in auth.json. */
  id: string;
  /** Display name (from built-in catalog or custom). */
  displayName: string;
  /** Environment variable names that can supply this provider's API key. */
  envKeys: string[];
}

export interface AuthConfigSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  sourceState: "missing" | "valid" | "invalid";
  providers: AuthProviderDraft[];
  diagnostics: AuthConfigDiagnostic[];
  /** List of known providers with their env var mappings for UI suggestions. */
  knownProviders: AuthProviderInfo[];
}

export interface SaveAuthConfigInput {
  expectedRevision: string;
  providers: AuthProviderDraft[];
}

export type SaveAuthConfigResult =
  | { status: "saved"; snapshot: AuthConfigSnapshot }
  | { status: "invalid"; diagnostics: AuthConfigDiagnostic[] }
  | { status: "conflict"; current: AuthConfigSnapshot };
```

与 `models.json` draft 不同，auth draft 结构更扁平：
- 没有嵌套的 models/overrides/compat 层次；
- `env` 使用 `AuthEnvEntry[]` 数组（类似 `ModelsMapEntryDraft`），保留 origin key 以支持 rename；
- OAuth 字段完全只读，由 main 在 snapshot 时从 `AuthStorage` 读取并序列化摘要信息；
- `knownProviders` 包含 built-in provider 和对应环境变量名，供 renderer 展示建议。

### 7.2 Snapshot lifecycle

```text
main loads auth.json -> parses -> projects to AuthConfigSnapshot -> sends to renderer
renderer mutates AuthProviderDraft[] -> sends SaveAuthConfigInput -> main validates -> writes auth.json -> returns new snapshot
```

`key` 和 `env[].value` 是 raw string，renderer 可自由编辑。Optional property 以省略表示未配置，不使用 `undefined` 作为需要跨 structured clone 的业务值。

### 7.3 Key 字段 validation

Main 在 save 时对每个 API key credential 做 key 验证：

| Pattern | 规则 |
|---------|------|
| `!command` | 必须以 `!` 开头且后跟至少 1 个非空白字符；`!!invalid` |
| `$ENV` / `${ENV}` | 必须匹配 `$` 后跟合法标识符或 `${...}`；括号必须闭合 |
| `$$escaped` / `$!escaped` | `$$` 转义 `$`，`$!` 转义 `!`，后接任意字符 |
| literal | 非空字符串（空字符串在 normalize 时删除 property） |

空 key 在保存前 normalize 为 delete（不在 `auth.json` 中写 `""`，因为 Pi schema 要求 `key` 非空）。如果 provider 在保存后 `key` 为空，该 provider 从 `auth.json` 中删除。

Key validation 只做语法检查，不执行 `!command`，不解析 `$ENV` 的值，不访问网络。

## 8. 组件契约和目录结构

新增和修改的文件：

### 8.1 Shared

```text
packages/desktop/src/shared/auth-config-contracts.ts     # 新增
packages/desktop/src/shared/channels.ts                  # 修改：新增 auth* channels
packages/desktop/src/shared/desktop-api.ts               # 修改：新增 auth namespace
```

### 8.2 Main

```text
packages/desktop/src/main/auth/auth-config-service.ts    # 新增
packages/desktop/src/main/ipc.ts                         # 修改：注册 auth IPC handlers
```

### 8.3 Preload

```text
packages/desktop/src/preload/index.ts                    # 修改：暴露 desktop.auth API
```

### 8.4 Renderer — features

```text
packages/desktop/src/renderer/src/features/settings/
  auth-settings-page.tsx              # 新增：主页面
  auth-provider-list.tsx              # 新增：provider 列表
  auth-provider-detail.tsx            # 新增：credential detail
  auth-api-key-form.tsx               # 新增：API key 编辑表单
  auth-oauth-display.tsx              # 新增：OAuth 只读展示
  auth-env-editor.tsx                 # 新增：env 覆盖 key-value 编辑器
  auth-settings-model.ts              # 新增：inline mutation 逻辑
  use-auth-settings-controller.ts     # 新增：controller hook
```

### 8.5 Renderer — routes

```text
packages/desktop/src/renderer/src/app/routes/settings.auth.tsx  # 新增
```

### 8.6 Renderer — settings layout

```text
packages/desktop/src/renderer/src/features/settings/settings-page.tsx  # 修改：增加凭据菜单
```

### 8.7 Styles

```text
packages/desktop/src/renderer/src/styles/settings.css   # 修改或新增
```

### 8.8 Tests

```text
packages/desktop/test/auth-config-service.test.ts
packages/desktop/test/auth-ipc.test.ts
packages/desktop/test/auth-settings-page.test.tsx       # 或 auth-settings-components.test.tsx
packages/desktop/test/auth-settings-model.test.ts
```

## 9. AuthConfigService（main）

### 9.1 职责

`AuthConfigService` 是 `auth.json` 的唯一读写入口，与 `ModelsConfigService` 并列，不继承、不包装、不委托 `ModelsConfigService`。

职责：
- 读取 `auth.json` 并解析为 `AuthProviderDraft[]`；
- 序列化 `AuthProviderDraft[]` 为 JSON，保留 JSONC 注释和格式；
- key 字段语法校验；
- revision tracking（SHA-256 hash of raw bytes）；
- 原子写入：temp file + rename + fsync；
- lock via `proper-lockfile`；
- OAuth credential 摘要化（不把 raw token 发给 renderer）。

### 9.2 接口

```ts
export class AuthConfigService {
  readonly path: string;
  readonly agentDir: string;

  constructor(agentDir: string, options?: { log?: (message: string) => void });

  /** Read auth.json and project to AuthConfigSnapshot. */
  getConfig(): Promise<AuthConfigSnapshot>;

  /** Return current revision hash for polling. */
  getConfigRevision(): Promise<string>;

  /** Return path for external editor open. */
  getExternalOpenTarget(): Promise<string>;

  /** Save providers with expected revision. */
  saveConfig(input: SaveAuthConfigInput): Promise<SaveAuthConfigResult>;
}
```

### 9.3 Serialization 策略

与 `models.json` 不同，`auth.json` 的结构极其简单（flat `Record<string, { type, key, env? }>`），不需要复杂的 JSONC 节点操作。

序列化策略：
- 首次写入或 source-invalid 恢复：使用 `JSON.stringify(data, null, 2)`；
- 已有 valid 文件时：解析 JSONC tree，对已知 key 做 inline replace，保留注释和未知字段；
- 策略与 `ModelsConfigService.applyValueDiff()` 等价，但路径层级更浅（仅 `["providerKey"]` 和 `["providerKey", "env"]`）。

序列化优先级：
1. 文件不存在 → `JSON.stringify` 默认缩进；
2. 文件存在且 valid → JSONC tree 修改；
3. 文件存在但 invalid → 回退到 `JSON.stringify`（用户已看到 source-invalid 提示，重建后注释会丢失，这在 source-invalid 流程中是可接受的）。

### 9.4 Key validation

在 `saveConfig()` 中对每个非 OAuth provider 的 `apiKey.key` 做语法校验：

```ts
function validateKeySyntax(key: string): { ok: true } | { ok: false; message: string } {
  if (key.length === 0) return { ok: false, message: "API key 不能为空" };
  if (key.startsWith("!")) {
    const cmd = key.slice(1);
    if (cmd.length === 0 || cmd.trim().length === 0) {
      return { ok: false, message: "!command 格式无效：命令不能为空" };
    }
    if (cmd.startsWith("!")) {
      return { ok: false, message: "!command 格式无效：使用 $! 转义字面量 !" };
    }
  }
  if (key.startsWith("$") && !key.startsWith("$!") && !key.startsWith("$$")) {
    // Simple env var check: ${NAME} brackets must match
    const bracketCount = { open: 0, close: 0 };
    for (let i = 0; i < key.length; i++) {
      if (key[i] === "{") bracketCount.open++;
      if (key[i] === "}") bracketCount.close++;
      if (bracketCount.close > bracketCount.open) {
        return { ok: false, message: "环境变量模板括号不匹配" };
      }
    }
    if (bracketCount.open !== bracketCount.close) {
      return { ok: false, message: "环境变量模板括号不匹配" };
    }
  }
  return { ok: true };
}
```

Key validation 不执行 command、不解析 env value、不验证 API key 合法性（不做 endpoint 调用）。

### 9.5 Env entry key validation

```ts
const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/i;

function validateEnvKey(key: string): boolean {
  return VALID_ENV_KEY.test(key);
}
```

### 9.6 OAuth 脱敏

在 snapshot 时，OAuth credential 不包含 raw `access_token` 或 `refresh_token`。Main 仅暴露：
- `providerName`：从 `getOAuthProviders()` 获取；
- `expires`：绝对过期时间的 ISO string；
- `expired`：布尔值。

不把 expired token 当作 error。页面展示橙色 warning 图标和剩余时间，但不阻止保存。

### 9.7 Revision 和锁

与 `ModelsConfigService` 一致：
- Revision = SHA-256 of raw file bytes；
- Missing file → `"missing:auth-config-v1"` revision；
- 写入使用 `proper-lockfile` 锁 + temp file + rename + fsync；
- Lock options 与 models service 一致 (stale 30s, retries 6)。

## 10. IPC 通道

### 10.1 新增 channels

```ts
// channels.ts 新增
authGetConfig: "desktop:auth:get-config",
authGetConfigRevision: "desktop:auth:get-config-revision",
authSaveConfig: "desktop:auth:save-config",
authOpenConfigExternally: "desktop:auth:open-config-externally",
authSetEditorDirty: "desktop:auth:set-editor-dirty",
```

### 10.2 IPC handlers（ipc.ts）

```ts
// 在 registerIpc 中新增
ipcMain.handle(CHANNELS.authGetConfig, () => auth.getConfig());
ipcMain.handle(CHANNELS.authGetConfigRevision, () => auth.getConfigRevision());
ipcMain.handle(CHANNELS.authSaveConfig, (_event, input: SaveAuthConfigInput) => auth.saveConfig(input));
ipcMain.handle(CHANNELS.authOpenConfigExternally, async () => openPath(await auth.getExternalOpenTarget()));
ipcMain.on(CHANNELS.authSetEditorDirty, (event, dirty: unknown) => {
  if (typeof dirty !== "boolean") { event.returnValue = false; return; }
  const ownerId = event.sender.id;
  dirtyGuard.setDirty(ownerId, dirty);
  if (!authEditorWebContents.has(ownerId)) {
    authEditorWebContents.add(ownerId);
    event.sender.once("destroyed", () => {
      authEditorWebContents.delete(ownerId);
      dirtyGuard.remove(ownerId);
    });
  }
  event.returnValue = true;
});
```

`authEditorWebContents` 和 `modelEditorWebContents` 各自独立管理。`DirtyGuard` 的按 webContents 隔离意味着同时打开 `models` 和 `auth` 两个非 dirty 的 settings 标签不会阻止关闭。一个 dirty 另一个 clean 时 main 仍提示确认。

### 10.3 registerIpc 签名更新

`registerIpc` 新增 `auth: AuthConfigService` 参数。为不影响已有调用，services 向 registerIpc 传参方式不做 breaking change。

## 11. Preload API

### 11.1 DesktopApi 扩展

```ts
// desktop-api.ts 新增
auth: {
  getConfig(): Promise<AuthConfigSnapshot>;
  getConfigRevision(): Promise<string>;
  saveConfig(input: SaveAuthConfigInput): Promise<SaveAuthConfigResult>;
  openConfigExternally(): Promise<void>;
  setEditorDirty(dirty: boolean): boolean;
};
```

### 11.2 Preload bridge

在 `preload/index.ts` 中暴露：

```ts
auth: {
  getConfig: () => ipcRenderer.invoke(CHANNELS.authGetConfig),
  getConfigRevision: () => ipcRenderer.invoke(CHANNELS.authGetConfigRevision),
  saveConfig: (input) => ipcRenderer.invoke(CHANNELS.authSaveConfig, input),
  openConfigExternally: () => ipcRenderer.invoke(CHANNELS.authOpenConfigExternally),
  setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.authSetEditorDirty, dirty) === true,
},
```

## 12. Renderer 组件

### 12.1 AuthSettingsPage

顶层页面组件，结构：

```tsx
<AuthSettingsPage>
  <header>
    <div>凭据</div>
    <span>{path}</span>
    <status text />
    <Button open externally />
    <Button reload />
    <Button save disabled={!canSave} />
  </header>

  {error && <ErrorBanner />}
  {conflict && <ConflictBanner />}
  {diagnostics.length > 0 && <DiagnosticsBanner />}

  {loading && <Skeleton />}
  {sourceInvalid && <SourceInvalidBanner />}
  {snapshot && (
    <div className="auth-workbench">
      <AuthProviderList
        providers={draft}
        knownProviders={snapshot.knownProviders}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        onAdd={handleAdd}
      />
      <main className="auth-detail-pane">
        {selectedProvider ? (
          <AuthProviderDetail
            provider={selectedProvider}
            knownProviders={snapshot.knownProviders}
            onChange={updateProvider}
            onRemove={removeProvider}
          />
        ) : (
          <EmptyDetail />
        )}
      </main>
    </div>
  )}

  {/* Route dirty guard and save confirmation dialogs */}
</AuthSettingsPage>
```

页面状态管理通过 `useAuthSettingsController` hook，结构与 `useModelsSettingsController` 一致：
- `draft`, `snapshot`, `status`, `error`, `diagnostics`；
- `selectedKey` / `selectProvider()`；
- `mutate()` - 传递 `(providers: AuthProviderDraft[]) => void`；
- `reload()`, `save()`；
- `routeBlocked` / `discardAndProceed()` / `cancelRouteChange()`；
- `pendingConfirmation`（auth 暂不需要；保留 API 但 auth.json 结构不触发 rename confirmation）。

### 12.2 AuthProviderList

左侧列表：

```tsx
<AuthProviderList
  providers={draft}
  knownProviders={knownProviders}
  selectedKey={selectedKey}
  onSelect={(key) => void}
  onAdd={(key: string) => void}
/>
```

- 搜索过滤（按 provider key 和 display name）；
- 每行显示 provider key、凭据类型标签、来源指示器；
- "添加 provider" 入口：弹出 combobox 从 known providers 选择 + custom key 输入；
- 如果 provider 仅存在于环境变量 / models.json 但不在 `auth.json` 中：显示半透明行，点击后只读展示其来源。

### 12.3 AuthProviderDetail

右侧详情面板。

#### API key form

```tsx
<AuthApiKeyForm provider={provider} onChange={(next) => void}>
  <div className="field">
    <label>API Key</label>
    <div className="key-input-group">
      <input type={showKey ? "text" : "password"} value={provider.apiKey.key} onChange={...} />
      <button onClick={toggleShow} aria-label={showKey ? "隐藏" : "显示"}>
        <Eye / EyeOff />
      </button>
    </div>
    <p className="field-hint">支持字面量、$ENV 变量、!command 命令</p>
    {keySyntaxError && <p className="field-error">{keySyntaxError}</p>}
  </div>

  <AuthEnvEditor env={provider.apiKey.env} onChange={(env) => void} />
</AuthApiKeyForm>
```

#### OAuth display

```tsx
<AuthOauthDisplay oauth={provider.oauth} onRemove={() => void}>
  <div className="oauth-info">
    <span>登录提供商: {oauth.providerName}</span>
    <span>过期时间: {expiresRelative}</span>
    {oauth.expired && <WarningIcon />}
  </div>
  <Button variant="destructive" onClick={onRemove}>移除</Button>
</AuthOauthDisplay>
```

### 12.4 AuthEnvEditor

可增删 key-value rows 的表格编辑器：

```tsx
<AuthEnvEditor env={envEntries} onChange={(entries) => void}>
  <table>
    <thead><tr><th>键</th><th>值</th><th></th></tr></thead>
    <tbody>
      {entries.map((entry, index) => (
        <tr key={entry.key}>
          <td><input value={entry.key} placeholder="CLOUDFLARE_ACCOUNT_ID" /></td>
          <td><input value={entry.value} /></td>
          <td><button onClick={() => removeEntry(index)}><Trash2 /></button></td>
        </tr>
      ))}
    </tbody>
  </table>
  <button onClick={addEntry}><Plus /> 添加</button>
</AuthEnvEditor>
```

- Env key 校验使用 `/^[A-Z_][A-Z0-9_]*$/i`；
- 空 key 在保存前 normalize 为 delete；
- 重命名经由 origin key 追踪。

### 12.5 Known provider info 显示

在 provider detail 中显示相关环境变量信息：

```tsx
{knownProvider && (
  <div className="provider-env-info">
    <p>关联环境变量: <code>{knownProvider.envKeys.join(", ")}</code></p>
    {knownProvider.envKeys.length > 0 && (
      <p className="field-hint">
        当前 shell: {envKeysStatus(knownProvider.envKeys)}
      </p>
    )}
  </div>
)}
```

Main 在 snapshot 时不检查环境变量状态；renderer 在 UI 中展示提示但不做实时环境检查。`envKeysStatus()` 只显示静态信息，不调用子进程。

### 12.6 脱敏展示

在 provider list 中，API key 值脱敏展示：
- 前 6 字符 + `...` + 后 4 字符；
- 如果 key 是 `$ENV` 或 `!command` 格式，展示原始格式但不脱敏（因为它们不是 secret 本身）；
- OAuth 展示过期时间和 provider 名。

## 13. 凭据来源展示

### 13.1 Provider 凭据来源

每个 provider 的凭据可能来自多处。UI 在 provider list 行中展示一个小标签表示当前来源：

| 条件 | 标签 | 行为 |
|------|------|------|
| 在 `auth.json` 中存在 | `auth.json` | 可编辑 |
| 仅在 env var 中存在 | `环境变量` | 只读（提示来源，不在此页管理） |
| 仅 CLI `--api-key` 传入 | `CLI` | 只读 |
| 仅在 `models.json` `apiKey` 中 | `models.json` | 只读 |
| 以上多处同时存在 | 多个标签 stack | 可编辑（`auth.json` 部分） |

### 13.2 只读 provider

对于不在 `auth.json` 中的 provider（仅 env / CLI / models.json），UI 展示只读视图：
- 不清除或修改来自其他来源的凭据；
- 显示凭据来源和关联 env var；
- 提供"添加到 auth.json"按钮，将当前已知的 provider key 添加到 `auth.json` 并打开编辑器。

## 14. 样式和响应式

### 14.1 宽屏（>= 1024px）

主从两列布局：
- 左侧 provider 列表：240px min / 320px max，可拖拽；
- 右侧 detail：自适应剩余宽度；
- 顶部工具栏 fixed。

### 14.2 窄屏（< 1024px）

单列：
- Provider 列表占满宽度；
- 选择 provider 后进入 detail 视图，顶部提供 `<ArrowLeft` 返回按钮；
- Detail 表单垂直排列，label 在上、input 在下。

### 14.3 CSS

复用 `settings.css` 中 models 页的 layout token（padding、gap、font-size、border-radius 等）。新增 class 使用 `auth-settings-*` 和 `auth-*` 前缀，不与 `models-settings-*` 冲突。

### 14.4 Theme

支持 `light` 和 `dark`，使用 CSS variables。不新增主题变量。

## 15. 测试计划

### 15.1 AuthConfigService

必须覆盖：

- missing 不创建文件；
- valid load 产生正确 `AuthProviderDraft[]`；
- source-invalid（JSON 解析失败）；
- API key `key` 字段 literal、`$ENV`、`!command`、`$$escape` 原样进入 snapshot；
- API key `env` 字段正确序列化/反序列化；
- OAuth credential 脱敏摘要（不含 token）；
- key 为空时保存为 delete provider；
- env 为空 map 时保存省略 `env` property；
- key syntax validation（合法 literal、合法 `!command`、合法 `$ENV`、`!!invalid`、不匹配括号）；
- env key validation；
- revision conflict；
- atomic write：temp file + rename + fsync；
- lock timeout；
- `0600` file 和 `0700` parent；
- symlink/non-file rejection；
- known providers 从 `models.json` metadata 获取 displayName 和 envKeys。

### 15.2 IPC/preload

- channel mapping；
- renderer 无 path 参数；
- result union round trip；
- thrown I/O error 保持 message；
- API key value 可通过 IPC round-trip；
- editor dirty 使用同步 IPC；
- preload bridge 暴露 `auth` namespace。

### 15.3 Renderer

- `/settings/auth` 可进入且菜单 active；
- `/settings` 默认仍是 personalization；
- loading/missing/clean/dirty/invalid/saving/saved；
- source-invalid；
- conflict 保留 draft；
- API key add/edit/delete round-trip；
- API key `input type="password"` 默认遮挡，toggle 可见；
- env entry add/edit/remove/rename；
- OAuth read-only display 和 remove；
- known provider info 和建议；
- 只读 provider（仅 env/CLI/models.json）正确展示来源标签；
- route dirty guard；
- keyboard/focus/ARIA；
- 窄窗口布局切换。

## 16. 验收标准

全部满足才视为完成：

1. 设置菜单存在"凭据"，`#/settings/auth` 可直接访问。
2. 进入设置不创建或 attach Pi session。
3. 页面操作实际 `<agentDir>/auth.json`，支持 `PI_CODING_AGENT_DIR`。
4. API key credential 的 `key` 和 `env` 字段都有结构化控件。`key` 使用 `input type="password"`。
5. 空 key 在保存时 normalize 为 delete provider。
6. 空 env map 在保存时省略 `env` property。
7. Key syntax validation 在 save 前执行，不执行 `!command`，不访问网络。
8. OAuth credential 仅展示摘要和过期状态，不暴露 raw token。OAuth 可移除但不可编辑。
9. 未编辑的 JSON 注释、格式、未知字段保留。
10. 保存使用进程内队列、跨进程 lock、expected revision 和同目录 atomic replace。
11. Invalid/conflict/write failure 不破坏原文件，也不丢失 renderer draft。
12. 新文件权限为 `0600`，父目录为 `0700`；特殊文件和 symlink 被拒绝。
13. Known provider 的 env var 映射和 display name 来自 `@earendil-works/pi-ai/compat` 的 `findEnvKeys()` 和 `models.json` 的 metadata，不 hard-code。
14. Provider list 显示凭据来源标签（auth.json / 环境变量 / CLI / models.json），每个 provider 的多重来源都能被展示。
15. 页面通过 focus + 5 秒 revision polling 检测外部修改；请求 single-flight；generation 防止 stale 响应覆盖。
16. Route 离开使用 React dialog；窗口 close/quit/reload 使用 main 原生确认且只弹一次。Models 和 auth 的 dirty guard 相互独立。
17. 保存只声明"新会话生效"，不会中断或修改 active session。
18. 路由、service、IPC、preload、renderer 状态和进程边界有 focused tests。
19. Renderer boundary、Desktop typecheck、根 `npm run check` 和 `git diff --check` 通过。
20. Electron 在 light/dark、1440x920 和 1024x680 下无文本溢出、控件重叠或焦点缺失。

## 17. 后续扩展

以下能力必须单独设计，不应顺手加入本实施：

- OAuth `/login` 流程的 GUI 集成；
- `models.json` `apiKey` 迁移到 `auth.json` 的自动化；
- 凭据有效性验证（endpoint probing）；
- active session worker 凭据热重载；
- 凭据导入/导出；
- 凭据加密存储；
- 团队凭据策略和只读 managed config。
