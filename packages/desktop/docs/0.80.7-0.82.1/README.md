# Pi 0.80.7 到 0.82.1 升级迁移计划

## 1. 计划信息

| 项目 | 值 |
| --- | --- |
| 当前 coding-agent 版本 | `0.80.7` |
| 目标 coding-agent 版本 | `0.82.1` |
| 当前 Desktop 版本 | `0.0.31` |
| 目标上游基线 | tag `v0.82.1`, commit `b4f293684` |
| 当前分支基线 | `257dd1691`，执行迁移时重新记录实际 HEAD |
| 合并基点 | `dcfe36c79702ec240b146c45f167ab75ecddd205` |
| 升级类型 | 破坏性、锁步、整仓源码迁移 |

本计划只覆盖从官方 `v0.80.7` 到 `v0.82.1` 的确定版本区间。不要直接以持续变化的 `upstream/main` 为迁移目标。完成 `v0.82.1` 集成并稳定后，再单独评估 `v0.82.1..upstream/main`。

**适配原则：** 先把 `packages/ai`、`packages/agent`、`packages/tui`、`packages/coding-agent`、`packages/server` 和 `packages/storage` 同步到官方 `v0.82.1`，再由 Desktop 适配新的 public API。允许对核心包做少量修改，但只能用于官方 API 确实缺失的通用能力或独立缺陷修复，不能用于继续暴露旧 Desktop 私有架构。每项核心偏差必须最小、无 Desktop 专用命名/环境变量、带核心包测试和 changelog，并登记在本计划的“核心偏差清单”中。

## 2. 结论

不能把本次升级当作普通版本号更新或无冲突合并。`0.80.8` 引入了模型与认证运行时的破坏性重构，当前 Desktop 又在 `0.80.7` 基础上增加了模型配置编辑器、受控扩展加载、资源热重载、内置 provider、sidecar 会话和 programmatic subagent。迁移必须同时完成以下工作：

1. 先用官方 `v0.82.1` 建立干净核心基线，再只重放经过偏差评审的通用核心改动。
2. 将 Desktop 的核心模型所有权从 `ModelRegistry` 迁到官方 `ModelRuntime` public API。
3. 将本地 `models-config` 类型、解析、metadata 和 JSONC 编辑能力迁入 `packages/desktop`。
4. 将默认模型解析和 thinking 能力计算迁入 Desktop adapter，组合官方 public API，不要求 coding-agent 新增导出。
5. 将 OAuth 登录和凭据刷新从已移除的 `AuthStorage` public API 迁到官方 `ModelRuntime`。
6. 将动态 extension generation reload 改成 Desktop 管理的 session/runtime 重建，不修改上游 `ResourceLoader` 或 `AgentSession.reload()`。
7. 手工合并根工作区配置，保留 Desktop，同时接收上游新增的 `server` 和 SQLite storage。
8. 重新生成所有依赖制品，并完成核心偏差审计、Desktop sidecar、扩展、模型配置和打包边界验证。

只有全部验收门通过后，才可以把升级结果合回主开发分支。

## 3. 范围和非目标

### 3.1 范围

- `packages/ai`
- `packages/agent`
- `packages/tui`
- `packages/coding-agent`
- `packages/desktop`
- `packages/orchestrator` 到 `packages/server` 的上游重命名
- `packages/storage/sqlite-node`
- 根 `package.json`、`package-lock.json`、`tsconfig.json`、`biome.json`
- coding-agent install-lock 和 shrinkwrap
- Desktop sidecar、受控扩展、provider/auth/models 设置页

### 3.2 非目标

- 不合并 `v0.82.1` 之后的 `upstream/main` 提交。
- 不在本次迁移中重新设计 Desktop UI。
- 不修改官方 `v0.82.1` 核心包来维持旧 Desktop 内部接口；必要的通用能力按偏差流程单独评审。
- 不删除现有 Desktop 功能来绕过类型错误；功能通过 Desktop adapter 迁移。
- 不把当前 JSONL Desktop 会话迁到 SQLite；只接收上游 storage 包并保持现有会话行为。
- 不顺带升级与 pi 无关的 Electron、React、assistant-ui 或 TanStack 依赖。
- 不改变用户的 `auth.json`、`models.json` 和历史 session 文件格式，除非上游迁移代码明确要求且有回归测试。

## 4. 已知事实和冲突基线

### 4.1 锁步版本

当前以下包都是 `0.80.7`：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-orchestrator`

目标版本必须整体对齐到 `0.82.1`。不能只修改 Desktop 对 `pi-coding-agent` 的依赖，因为 coding-agent 的运行时、类型和生成模型数据依赖同版本的 ai/agent/tui。

### 4.2 已确认的文本冲突

对当前 HEAD 和 `v0.82.1` 执行只读 `git merge-tree`，确认至少存在以下冲突：

- `biome.json`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/index.ts`

这些只是 Git 能识别的文本冲突，不包括自动合并后产生的 API 和行为冲突。

### 4.3 本地 coding-agent 定制

相对合并基点，本地修改了：

- `packages/coding-agent/package.json`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/model-resolver.ts`
- `packages/coding-agent/src/core/package-manager.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/index.ts`
- 对应的 install-lock、shrinkwrap 和测试
- 新增 `packages/coding-agent/src/core/models-config.ts`
- 新增 `@earendil-works/pi-coding-agent/models-config` 导出

这些本地修改必须逐项分类为“上游已有等价能力”“迁到 Desktop”“不再需要”。最终不在 pi 核心包中重放。冲突文件以官方 `v0.82.1` 为结果，Desktop 调用方随后适配。

### 4.4 当前未提交工作

开始升级前，必须先处理当前工作区里的 Windows 受管 Bash 集成，包括但不限于：

- `packages/coding-agent/src/utils/shell.ts`
- `packages/coding-agent/test/shell.test.ts`
- `packages/coding-agent/docs/windows.md`
- `packages/desktop/src/main/sidecar/managed-shell-locator.ts`
- `packages/desktop/electron-builder.yml`
- `scripts/prepare-desktop-managed-shell.mjs`
- `scripts/validate-desktop-package.mjs`

该工作与升级都涉及 coding-agent 和 Desktop 打包链路。升级分支必须从一个已提交、可复现的基线开始；不要使用 stash，不要在脏工作区直接 merge。

## 5. 目标架构决策

### 5.1 `ModelRuntime` 是应用层唯一模型所有者

目标版本中：

- `ModelRuntime` 负责模型配置、认证、动态 catalog、请求认证和 provider 注册。
- `ModelRegistry` 只保留给 extension context 的同步兼容视图。
- Desktop 主进程、thread sidecar 和 subagent sidecar 不再长期持有 `ModelRegistry`。
- `AgentSessionServices` 使用 `modelRuntime`，不再使用 `modelRegistry`。

Desktop 应统一使用：

- `modelRuntime.getModels()` 替代 `modelRegistry.getAll()`。
- `modelRuntime.getModel(provider, id)` 替代 `modelRegistry.find(provider, id)`。
- `await modelRuntime.getAvailable()` 或 `getAvailableSnapshot()` 替代同步 `getAvailable()`。
- `modelRuntime.hasConfiguredAuth(providerId)` 或 `await modelRuntime.checkAuth(providerId)` 替代对 model 对象调用 `hasConfiguredAuth()`。
- `await modelRuntime.refresh({ allowNetwork: false })` 替代 `authStorage.reload(); modelRegistry.refresh()`。

`getAvailableSnapshot()` 只能用于已经完成初始化/刷新后的同步渲染快照。创建、恢复、显式模型选择和保存配置后的正确性边界必须使用异步 `getAvailable()` 或 `checkAuth()`。

### 5.2 Desktop 自己实现默认模型和 thinking adapter

目标上游的 `findInitialModel` 是 coding-agent 内部实现，没有从包入口导出；本地 `resolveThinkingConfiguration` 也不是官方 API。Desktop 不再要求上游暴露它们。

在 `packages/desktop/src/main/pi/` 增加 Desktop adapter：

- 通过 `ModelRuntime.getModel()`、`getModels()`、`getAvailable()` 和 `hasConfiguredAuth()` 实现草稿默认模型选择。
- 从 `SettingsManager` 读取默认 provider/model/thinking。
- 使用 `@earendil-works/pi-ai` public `clampThinkingLevel()` 和 `getSupportedThinkingLevels()` 计算 thinking。
- 恢复已有 session 时仍优先使用 session 文件中的 model/thinking；不可用时把 fallback 交给官方 `createAgentSession()`。
- 用 characterization tests 固定 Desktop 需要的优先级，不测试或复制 coding-agent 私有函数实现细节。

这样 Desktop 行为可以显式维护，同时不会把内部 helper 变成 fork API。

### 5.3 models.json 编辑能力完全迁入 Desktop

删除对 `@earendil-works/pi-coding-agent/models-config` 的全部依赖，并允许官方 package 删除该子路径。Desktop 在自己的边界内维护：

- JSONC 解析和结构化 diagnostics。
- models.json editor contracts。
- built-in provider/model metadata 投影。
- 注释和未知字段保留。
- revision、原子写入、并发冲突与回滚。

推荐结构：

- `packages/desktop/src/main/models/models-config-schema.ts`：仅包含 Desktop 编辑器 schema、类型和纯校验。
- `packages/desktop/src/main/models/models-config-metadata.ts`：通过官方 `ModelRuntime.getProviders()/getModels()` 或 `@earendil-works/pi-ai/providers/all` public API生成 metadata。
- `packages/desktop/src/main/models/models-config-service.ts`：继续负责文件事务和 JSONC patch。
- `packages/desktop/src/shared/models-config-contracts.ts`：定义 IPC 可序列化类型，不从 coding-agent 引用类型。

由于官方没有公开纯 models.json parser，Desktop schema 必然是适配层。通过契约测试控制漂移：

1. 测试样例先通过 Desktop schema。
2. 写入临时 models.json。
3. 使用官方 `ModelRuntime.create({ modelsPath, credentials, modelsStore })` 加载。
4. 断言 `runtime.getError()` 与 Desktop 判定一致。
5. 对 Desktop 不认识的新字段继续原样保留，避免保存时破坏前向兼容。

目标 schema 至少覆盖 `0.82.1` 的 `supportsOpenAIGrammarTools`、`deferredToolsMode`、`supportsStrictTools` 和 OpenAI Responses strict/grammar flags。不再把 `zaiToolStream` 作为可编辑字段，但必须保留原始未知字段。

### 5.4 OAuth 和 auth.json 迁移到 `ModelRuntime`

目标版本不再从包入口导出 `AuthStorage`。Desktop 不得从内部路径绕过该限制。

迁移方式：

- Desktop 登录使用 `ModelRuntime.login(providerId, "oauth", interaction)`。
- 将现有 `OAuthLoginCallbacks` UI 适配为目标 `AuthInteraction`：
  - `prompt(prompt)` 负责输入和选择。
  - `notify(event)` 处理 auth URL、device code、info 和 progress。
  - 登录取消通过 `AbortSignal` 传播。
- provider 列表和认证状态从 `modelRuntime.getProviders()`、`checkAuth()`、`getProviderAuthStatus()` 获取。
- 对 auth.json 的原子编辑、revision 和回滚仍由 Desktop `AuthConfigService` 负责。
- 一次性只读需求使用 `readStoredCredential()`；不要重新公开 `AuthStorage`。
- 配置保存后刷新共享的 `ModelRuntime`，使活动会话和设置页看到同一凭据快照。

### 5.5 受控扩展 reload 改为 Desktop runtime replacement

官方 `v0.82.1` 的 `AgentSession.reload()` 不能替换 `additionalExtensionPaths`，也没有 Desktop 的 `packageManagerOnMissing` 策略。不得为此修改上游。

Desktop 改为管理完整 session runtime replacement：

1. extension generation 变化时先拒绝仍在 streaming/compacting 的 session。
2. 保存旧 generation、session file/cwd/model/thinking 和控制面状态。
3. 用新的批准路径创建全新的 `createAgentSessionServices()`；所有路径在进入官方 API 前已由 Desktop 校验存在、hash、来源和依赖。
4. 使用同一 session 文件重建 `AgentSession`，重新 bind extensions、projector、host 和 event subscriptions。
5. 成功后原子替换 Desktop 当前 runtime 并 dispose 旧 session。
6. 候选 runtime 创建失败时 dispose 候选，并按旧 generation 重建或保留旧 runtime；向 renderer 发布明确 diagnostic。

Desktop 不把缺失 package source 交给官方交互式安装路径。marketplace/curated extension 安装在进入 session runtime 前由 Desktop 自己完成，传给 `additionalExtensionPaths` 的只能是已解析的本地绝对入口。

该方案需要把当前 `SessionRuntime.session`、projector、extension host 和 unsubscribe 从 readonly 单次构造结构重构为可替换的内部 runtime bundle。替换过程必须有并发锁，禁止 prompt/reload/dispose 交叉执行。

### 5.6 managed Bash 通过 SettingsManager 注入

官方 `v0.82.1` 已支持 `settings.shellPath`、`SettingsManager` 和 `createLocalBashOperations({ shellPath })`。Desktop 不增加 `PI_CODING_AGENT_MANAGED_BASH_PATH` 等上游环境变量约定。

- Desktop 继续负责定位和校验 packaged managed Bash。
- 创建 thread/subagent services 前，对 Desktop 专用 `SettingsManager` 应用非持久化 `shellPath` override。
- 用户显式 `shellPath` 保持最高优先级；只有用户未配置时才注入 managed Bash。
- 终端 subsystem 和 coding-agent session 使用同一个解析结果。
- 打包脚本仍由 Desktop 提供 MinGit/MSYS2 资源和校验。

### 5.7 根工作区采用并集，不接受整边覆盖

根配置合并必须满足：

- 保留 `packages/desktop` workspace、构建脚本、renderer boundary 检查和 Biome overrides。
- 接收上游 `packages/storage/*` workspace。
- 接收 `orchestrator` 到 `server` 的正式重命名。
- 更新 root build/check 脚本时继续包含 Desktop 所需检查。
- `tsconfig.json` 增加 `NodeNext`、storage/server paths，同时继续隔离 Desktop 自己的多 tsconfig 编译边界。
- Biome 保留 Desktop 两空格和 TSX/CSS 规则，同时加入 storage 包扫描。
- 根 `@types/node` 版本必须结合 Electron/Desktop 实际类型检查决定，不直接选择某一边。

### 5.8 核心偏差清单

初始方案不要求核心偏差。实施中只有通过本节门槛的项目才能加入；未登记的 core diff 一律移回 Desktop 或删除。

| 状态 | 包/路径 | 通用能力或缺陷 | 为什么 Desktop adapter 不足 | 核心测试 | Changelog |
| --- | --- | --- | --- | --- | --- |
| 无 | - | 当前无批准偏差 | - | - | - |

新增偏差时必须把“无”行替换为具体记录，并在对应阶段写明 public API、调用方和回滚方式。以下现有本地改动默认不进入偏差清单：

- `@earendil-works/pi-coding-agent/models-config` 子路径。
- `findInitialModel`、`resolveThinkingConfiguration` 额外 public exports。
- `PI_CODING_AGENT_MANAGED_BASH_PATH`。
- 仅供 Desktop generation 切换的 `AgentSession.reload({ resourceLoader })`。
- 仅供 Desktop fail-closed 安装策略的 package-manager callback。

它们分别由 Desktop models adapter、model-selection adapter、SettingsManager override、runtime replacement 和预解析 extension pipeline 取代。若实现证据证明其中某项必须进入核心，先更新本节并获得审查结论，再修改 core。

## 6. 执行阶段

## 阶段 0：冻结基线并建立安全工作区

### 操作

1. 完成并提交当前未提交功能，确保升级起点可复现。
2. 记录：
   - `git rev-parse HEAD`
   - `git status --short --branch`
   - `git describe --tags --always --dirty`
3. 创建保护分支，例如 `backup/pre-pi-0.82.1`。
4. 创建独立升级分支，例如 `upgrade/pi-0.80.7-to-0.82.1`。
5. 刷新目标 tag：`git fetch upstream tag v0.82.1`。
6. 运行迁移前基线检查并保存输出。

### 基线命令

```bash
npm --prefix packages/desktop run typecheck
npm run check
./test.sh
```

如全量 `npm run check` 因迁移前已知 shrinkwrap/install-lock 不一致失败，必须记录准确失败点，并单独执行其后的 TypeScript、renderer boundary 和 browser smoke 检查。不能把既有失败误记为升级回归。

### 退出条件

- 工作区干净。
- 基线 commit 和保护分支存在。
- 基线失败有书面记录。
- `v0.82.1` tag 对应 `b4f293684`。

## 阶段 1：机械合并官方 tag

### 操作

1. 在升级分支执行 `git merge --no-commit v0.82.1`。
2. 对官方核心包的冲突统一采用 `v0.82.1` 内容；不要在冲突中重放 Desktop 兼容代码。
3. 删除仅存在于本地 fork 的 coding-agent 文件和 exports，例如 `core/models-config.ts` 与 `./models-config`。
4. 将需要保留的行为登记为 Desktop 迁移任务，再修改 Desktop 调用方。
5. 手工合并根配置和 Desktop 专用脚本，最后生成 lockfile。
6. 对自动合并的官方核心路径也执行一致性校验，防止残留无冲突的本地补丁。

### 冲突解决顺序

1. 将 `packages/ai`、`packages/agent`、`packages/tui`、`packages/coding-agent`、`packages/server`、`packages/storage` 恢复为 tag 内容。
2. 删除被官方 tag 删除或重命名的本地核心文件。
3. 解决根 `package.json`、`tsconfig.json`、`biome.json`，只在这些聚合配置中保留 Desktop 条目。
4. 迁移 `packages/desktop` 调用方和 Desktop 专用脚本。
5. 最后生成 `package-lock.json`。

### 核心基线与偏差门

机械合并完成、尚未实施适配时，以下命令必须通过，用于证明迁移从干净 `v0.82.1` 核心开始：

```bash
git diff --exit-code v0.82.1 -- packages/ai packages/agent packages/tui packages/coding-agent packages/server packages/storage
```

后续如确需修改核心包，最终允许该命令显示差异，但每个差异路径必须出现在“核心偏差清单”，并满足：

- 能力是通用 SDK/运行时能力，不含 Desktop 类型、路径、产品名或环境变量。
- 设计遵循 `0.82.1` 的 `ModelRuntime`、ResourceLoader 和 AgentSession 所有权。
- 不重新公开已删除的 `AuthStorage`、`models-config` 或内部模型选择 helper。
- 有核心包针对性测试和对应 `CHANGELOG.md` 条目。
- Desktop 有调用该 public 能力的集成测试。
- 不存在可接受的纯 Desktop adapter 实现，或纯 Desktop 实现会破坏正确性边界。

最终要求是“零未登记核心差异”，不是“核心绝对零差异”。

### 退出条件

- `git diff --check` 无冲突标记和空白错误。
- 所有源码冲突均有明确决策记录。
- 暂不要求类型检查通过，但不存在未解决 Git 冲突。

## 阶段 2：锁步包与工作区结构对齐

### 操作

1. 将 ai/agent/tui/coding-agent/server/storage 的发布包版本对齐到 `0.82.1`。
2. Desktop 依赖更新为：
   - `@earendil-works/pi-coding-agent: 0.82.1`
   - `@earendil-works/pi-ai: 0.82.1`
3. 接收上游生成模型数据和 package files 配置。
4. 接收 `protobufjs: 7.6.5` 安全 override。
5. 将本地对 `orchestrator` 的引用迁到 `server`，不同时保留两个发布包身份。
6. 检查 Desktop sidecar manifest、插件 host compatibility 和打包脚本是否记录 pi 包版本或包名。
7. 保留 Desktop 自身版本 `0.0.31`，除非发布流程另有版本决定。

### 重点文件

- `package.json`
- `packages/desktop/package.json`
- `packages/coding-agent/package.json`
- `packages/server/package.json`
- `packages/storage/sqlite-node/package.json`
- `scripts/generate-desktop-sidecar-manifest.mjs`
- `scripts/validate-desktop-package.mjs`

### 退出条件

- 所有 pi 发布包版本锁步。
- 工作区不再引用 `@earendil-works/pi-orchestrator`。
- Desktop build/check 脚本仍存在且路径有效。

## 阶段 3：将 models.json adapter 迁入 Desktop

### 操作

1. 从 Desktop 源码删除所有 `@earendil-works/pi-coding-agent/models-config` imports。
2. 在 Desktop 新建 schema、diagnostic 和 metadata 模块。
3. 将现有 `ModelsConfig*` 类型迁入 `packages/desktop/src/shared/models-config-contracts.ts` 或 Desktop main 私有模块。
4. metadata 通过官方 public catalog/runtime API生成，不导入 coding-agent 内部文件。
5. 更新 Desktop editor 支持的 `0.82.1` compat 字段。
6. 保留 JSONC 注释、未知字段、key rename、model 数组删除、revision、原子写入和双文件回滚。
7. 增加 Desktop schema 与官方 `ModelRuntime` 的临时文件契约测试。

### 必测场景

- 缺失 models.json。
- JSONC 注释和 trailing comma。
- 语法错误和 schema 错误路径。
- 自定义 provider 缺少 baseUrl/api。
- modelOverrides。
- pricing tiers。
- thinkingLevelMap 空洞。
- `supportsOpenAIGrammarTools`。
- `deferredToolsMode: "kimi"`。
- `supportsStrictTools`。
- 未知未来字段保留。
- 旧 `zaiToolStream` 不被 UI 重写或删除。
- Desktop 校验结果与官方 `ModelRuntime` 加载结果一致。

### 重点文件

- `packages/desktop/src/main/models/models-config-schema.ts`
- `packages/desktop/src/main/models/models-config-metadata.ts`
- `packages/desktop/src/main/models/models-config-service.ts`
- `packages/desktop/src/shared/models-config-contracts.ts`
- `packages/desktop/src/shared/providers-config-contracts.ts`
- `packages/desktop/src/renderer/src/features/settings/models-*.tsx`
- `packages/desktop/test/models-config-service.test.ts`
- 新增的 schema/runtime contract test

### 退出条件

- Desktop 不再导入 `@earendil-works/pi-coding-agent/models-config`。
- 官方 coding-agent package 保持原始 exports。
- Desktop 现有 JSONC 保存性质全部通过。
- 新 `0.82.1` 字段有解析和 round-trip 测试。
- Desktop 接受的配置可被官方 `ModelRuntime` 加载。

## 阶段 4：Desktop 主进程认证与 provider 配置迁移

### 操作

1. 在主进程为 agentDir 创建共享 `ModelRuntime`。
2. 用共享 runtime 替换 `AuthStorage`/`ModelRegistry` 构造。
3. `AuthConfigService.loginOauth()` 改用 `ModelRuntime.login()`。
4. 将 OAuth UI callbacks 适配为 `AuthInteraction`。
5. provider metadata 优先来自共享 runtime 的 provider/model catalog；静态 metadata facade 只负责编辑器所需 schema 信息。
6. models/auth 保存成功后调用一次受控 refresh，并把刷新失败转换为 Desktop diagnostic。
7. 保留 models/auth 双文件保存失败时的精确回滚。
8. 明确 runtime 生命周期，在 Electron `before-quit` 中不留下异步刷新任务。

### 重点文件

- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/auth/auth-config-service.ts`
- `packages/desktop/src/main/models/models-config-service.ts`
- `packages/desktop/src/main/providers/providers-config-service.ts`
- `packages/desktop/src/main/pi/desktop-builtin-provider.ts`
- `packages/desktop/src/main/subagents/subagent-settings-config-service.ts`
- 对应 auth/providers IPC 和测试

### 退出条件

- Desktop 源码不再导入 `AuthStorage`。
- 主进程模型、认证和 provider UI 使用同一 runtime 快照。
- API key、OAuth、环境变量和自定义 provider 状态都能正确显示。
- 保存配置后新建会话无需重启即可看到更新。

## 阶段 5：thread 与 subagent sidecar 迁移到 `ModelRuntime`

### 操作

1. 将 `SessionConfigurationServices.models` 改为 `ModelRuntime`。
2. `loadDraftSessionConfig()` 从 `services.modelRuntime` 获取模型。
3. 用 Desktop `model-selection-adapter.ts` 替换对私有 `findInitialModel`/本地 `resolveThinkingConfiguration` 的调用。
4. 将显式创建和恢复选择改为 `getModel()`、provider 级 auth 检查以及 pi-ai public thinking helpers。
5. `SessionRuntime` 持有 `ModelRuntime`，刷新函数改为异步。
6. 控制面发布模型列表时使用已完成刷新后的 snapshot，避免每次 render 发起异步 auth I/O。
7. `SubagentWorkerService` 在创建服务后先 await available models，再解析请求模型。
8. 更新所有 `ReturnType<...modelRegistry...>` 类型推导。
9. programmatic subagent 的 faux provider 测试改用 `ModelRuntime.create({ credentials, modelsPath: null })` 或目标 pi-ai 内存 credential store。

### API 对照

| 旧调用 | 新调用 |
| --- | --- |
| `services.modelRegistry` | `services.modelRuntime` |
| `registry.find(provider, id)` | `runtime.getModel(provider, id)` |
| `registry.getAll()` | `runtime.getModels()` |
| `registry.getAvailable()` | `await runtime.getAvailable()` |
| `registry.hasConfiguredAuth(model)` | `runtime.hasConfiguredAuth(model.provider)`，关键路径必要时 `await checkAuth()` |
| `registry.authStorage.reload()` | 删除；由 `runtime.refresh()` 重载 credentials/config |
| `registry.refresh()` | `await runtime.refresh({ allowNetwork: false })` |

### 重点文件

- `packages/desktop/src/main/pi/session-configuration.ts`
- `packages/desktop/src/main/pi/session-runtime.ts`
- `packages/desktop/src/sidecar/subagent-worker-service.ts`
- `packages/desktop/src/main/subagents/subagent-settings-config-service.ts`
- `packages/desktop/test/session-configuration.test.ts`
- `packages/desktop/test/session-runtime.test.ts`
- `packages/desktop/test/subagent-worker-service.test.ts`
- `packages/desktop/test/pi-public-compatibility.test.ts`

### 退出条件

- Desktop 非 extension 代码不再把 `ModelRegistry` 当应用层 runtime。
- 新建、恢复、切换模型、刷新模型和 subagent 显式选模通过测试。
- 未配置凭据、失效 OAuth 和不可用模型仍返回正确 readiness，而不是静默 fallback。

## 阶段 6：在 Desktop 实现受控 runtime replacement

### 操作

1. 将单个活动 Pi session 封装成可替换 bundle：session、modelRuntime、resourceLoader、projector、extensionHost 和 subscriptions。
2. 为 prompt/reload/dispose 增加串行化门，禁止替换期间接受新命令。
3. extension generation 更新时，用新的批准入口集合创建候选 bundle。
4. 候选 bundle 完成 extension load、bind、初始 projection 后才切换控制面引用。
5. 切换成功后 dispose 旧 bundle，并发布新 generation/revision。
6. 候选失败时清理候选，恢复旧 bundle 或按旧 descriptor 重建。
7. marketplace/curated 安装和依赖解析全部在 Desktop 进入官方 ResourceLoader 前完成；传入路径必须是已批准的绝对文件。
8. 验证 replacement 前后的 session_shutdown/session_start、projector checkpoint、host request 和 sidecar sequence。

### 重点文件

- `packages/desktop/src/main/pi/session-runtime.ts`
- `packages/desktop/src/main/pi/desktop-extension-runtime-policy.ts`
- `packages/desktop/src/main/pi/session-supervisor.ts`
- `packages/desktop/src/sidecar/thread-worker-service.ts`
- extension、reload、worker lifecycle 和 session resource 测试

### 退出条件

- 默认方案不修改官方 ResourceLoader/AgentSession；若实施中增加通用能力，已登记偏差并通过核心测试。
- generation replacement 不累积旧扩展或事件订阅。
- 未批准扩展不会被发现或自动安装。
- replacement 失败后旧 session 可继续使用或可确定性重建。
- 活动 run 期间 replacement 被拒绝。

## 阶段 7：事件、消息和 session 行为兼容验证

`0.81.x` 和 `0.82.x` 增加了 summarization retry、bash streaming、usage accounting 和更多 extension/provider 类型。即使 TypeScript 通过，也要确认 Desktop projector 和控制面不会丢事件或错误处理新联合成员。

### 操作

1. 审计 `AgentSessionEvent` switch/if 处理。
2. 明确处理或有意忽略：
   - `summarization_retry_scheduled`
   - `summarization_retry_attempt_start`
   - `summarization_retry_finished`
   - `bash_execution_update`
3. 检查 compaction/branch summary/tool result 的 usage 字段不会破坏 wire serialization。
4. 检查 upstream tool call ID 修复与 Desktop part ID 策略是否重复或冲突。
5. 检查 queue、abort、retry、compaction 和 session resume 的事件顺序。
6. 保留 Pi public compatibility characterization tests，并将名称更新为 `0.82.1`。

### 重点文件

- `packages/desktop/src/main/pi/pi-thread-projector.ts`
- `packages/desktop/src/main/pi/pi-compatibility-adapter.ts`
- `packages/desktop/src/main/pi/session-runtime.ts`
- `packages/desktop/src/sidecar/subagent-worker-service.ts`
- `packages/desktop/src/shared/sidecar-wire.ts`
- `packages/desktop/test/pi-public-compatibility.test.ts`
- projector、runtime、subagent 回归测试

### 退出条件

- public compatibility characterization 全部通过。
- 新事件不会导致 exhaustive switch 崩溃或 sidecar wire 拒绝。
- 普通、tool、retry、compaction、abort 和 resume timeline 均稳定。

## 阶段 8：orchestrator/server、storage 与根配置收敛

### 操作

1. 接受 `packages/orchestrator` 到 `packages/server` 的 rename。
2. 修改 package import、tsconfig path、build 脚本和文档引用。
3. 加入 `packages/storage/sqlite-node` workspace 与 TypeScript path。
4. 不将 Desktop 当前 JSONL SessionManager 改为 SQLite。
5. 合并 root `module/moduleResolution: NodeNext`，逐项修复真实 import 问题。
6. 保留 Desktop 从 root `tsgo` 排除、由三个专用 tsconfig 检查的边界，除非验证证明可以安全纳入。
7. 合并 Biome includes：core、storage 和 Desktop 都必须被正确检查。
8. 保留 `check:desktop-renderer` 和 Desktop browser/package 边界检查。

### 退出条件

- root workspace 无重复或失效包。
- server/storage 类型检查通过。
- Desktop 专用检查仍被 root `npm run check` 调用。
- renderer 未被 Node-only 模块污染。

## 阶段 9：依赖与生成制品

只有源码和 package metadata 稳定后才生成依赖制品。若核心 package metadata 没有经过批准的变化，coding-agent install-lock 和 shrinkwrap 保留 `v0.82.1` 内容；若批准的核心改动增加或调整依赖，则按仓库脚本重新生成并把制品列入同一核心偏差。

### 操作

```bash
npm install --package-lock-only --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs --check
npm run check:install-lock:coding-agent
```

如果 `--check` 失败，先区分是安装环境、根 workspace，还是已批准的核心依赖变化。没有核心 metadata 变化时不能直接接受生成后的 core diff；存在已批准变化时，按脚本生成、审查并登记制品差异。

如本地依赖需要 hydrate：

```bash
npm install --ignore-scripts
```

不要运行生命周期脚本。检查：

- 所有直接外部依赖仍为精确版本。
- workspace package 解析到 `0.82.1`。
- `protobufjs` override 为 `7.6.5`。
- Desktop 的 Electron native 依赖没有被意外重建。
- lockfile 没有无关的大范围 registry/integrity 抖动。
- shrinkwrap 和 install-lock 通过各自 `--check`。

### 退出条件

- 根 `package-lock.json` 与合并后的 workspace metadata 一致。
- coding-agent install-lock 和 shrinkwrap 通过检查；无核心依赖变化时与 `v0.82.1` 一致，有批准变化时与偏差清单一致。
- 没有生命周期脚本执行记录。
- 根 lockfile diff 能由 package metadata 变化解释。

## 阶段 10：分层验证

### 10.1 每修改一个测试文件后立即运行

从对应 package 目录运行具体测试，例如：

```bash
cd packages/desktop
node ../../node_modules/vitest/dist/cli.js --run test/models-config-service.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/auth-config-service.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/providers-config-service.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/session-configuration.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/session-runtime.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/subagent-worker-service.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/pi-public-compatibility.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/session-resources.test.ts
```

具体文件名以迁移后的测试结构为准。不要直接运行全量 vitest；仓库规则要求非 e2e 全量测试使用根 `./test.sh`。

### 10.2 Desktop 类型和边界

```bash
npm --prefix packages/desktop run typecheck
npm run check:desktop-renderer
npm run check:browser-smoke
```

### 10.3 全仓检查

```bash
npm run check
./test.sh
```

`npm run check` 必须查看完整输出，并修复所有 error、warning 和 info。

### 10.4 需要显式批准后执行的构建/打包验证

仓库规则禁止在未请求时运行 build。进入候选发布验证时，先获得明确批准，再运行：

```bash
npm --prefix packages/desktop run build
npm --prefix packages/desktop run smoke:sidecar
npm --prefix packages/desktop run smoke:gui
```

Windows 打包验证还应覆盖 managed Bash、node-pty、sidecar manifest 和 Electron resources。

### 退出条件

- 所有修改过的具体测试通过。
- Desktop typecheck 通过。
- `npm run check` 通过。
- `./test.sh` 通过。
- 获批后，Desktop sidecar 和 GUI smoke 通过。

## 阶段 11：手工验收矩阵

在隔离的测试 agentDir 上执行，不直接使用真实用户配置作为首次验证对象。

### 会话

- 无历史记录的新会话。
- 恢复 `0.80.7` JSONL 会话。
- 切换模型后继续对话。
- steering/follow-up queue。
- abort、retry、manual compaction、auto compaction。
- branch/fork 和 session title/preview 更新。

### 模型和认证

- 环境变量 API key。
- auth.json API key。
- OAuth 登录、取消、刷新和退出。
- 自定义 provider。
- provider model override。
- models.json 在运行中修改并刷新。
- 无凭据、错误凭据、过期 OAuth、不可用 scoped model。
- 离线启动时不依赖远程 catalog。

### 扩展和 subagent

- Hermes Memory 加载和 session events。
- pi-subagents 前台、异步、取消、超时和 transcript。
- curated/marketplace extension generation reload。
- extension 文件被篡改后的 hash 拒绝。
- 缺失扩展依赖时 fail-closed。
- reload 期间有活动 run 时拒绝。

### Desktop/打包

- Electron 主进程启动。
- thread、metadata、subagent 三类 sidecar 启动。
- renderer 模型/provider 设置页。
- managed Bash 用户配置优先级。
- packaged resources 中的 Pi assets、managed shell 和 sidecar manifest。
- Windows 路径、空格路径和非 ASCII 用户目录。

## 7. 回滚计划

### 7.1 代码回滚

- 迁移前创建只读保护分支 `backup/pre-pi-0.82.1`。
- 每个阶段形成独立、可审查的提交。
- 阶段失败时切回保护分支或新建修复分支，不使用 `git reset --hard`、`git checkout .` 或 stash。
- 不覆盖其他并行 session 的未提交文件。

### 7.2 用户数据回滚

首次手工验收使用独立临时 agentDir。进入真实数据 smoke 前，备份：

- `auth.json`
- `models.json`
- `models-store.json`
- `settings.json`
- `sessions/`
- Desktop `userData` 中的项目、插件和 marketplace 状态

本次迁移不应主动重写 session 文件。若运行目标版本后出现不可逆格式写入，立即停止真实数据测试，使用备份恢复并补迁移测试。

### 7.3 发布回滚

- 不覆盖已发布安装包。
- 新版本使用独立 Desktop 版本号和更新通道。
- 若候选版本失败，回滚 updater manifest 到上一稳定 Desktop 版本。
- 代码可回滚不代表 auth/OAuth token 可回滚；认证数据必须单独验证。

## 8. 风险登记

| 风险 | 严重度 | 触发信号 | 缓解措施 |
| --- | --- | --- | --- |
| ModelRegistry 到 ModelRuntime 的异步迁移产生陈旧 UI | 高 | 保存后模型列表不更新、恢复时误 fallback | 每个进程明确 runtime owner；关键边界 await refresh/checkAuth；同步路径只读 snapshot |
| Desktop models.json schema 与官方运行时漂移 | 高 | UI 保存后 Pi 拒绝加载 | 临时文件 + 官方 ModelRuntime 契约测试；未知字段无损保留 |
| OAuth API 迁移破坏登录 | 高 | device code 无 UI、取消不生效、token 不刷新 | AuthInteraction adapter；覆盖每类 AuthEvent 和 AbortSignal |
| 自动合并残留未登记 core 补丁 | 高 | 核心行为与官方 tag 无法解释 | 基线阶段要求零 diff；最终逐项匹配核心偏差清单 |
| Desktop runtime replacement 重复订阅或丢状态 | 高 | 重复事件、timeline 断裂、host request 泄漏 | bundle 生命周期、串行化门、成功/失败 replacement 测试 |
| 根配置覆盖 Desktop 检查 | 高 | check 通过但 renderer 引入 Node 模块 | 保留 `check:desktop-renderer` 和专用 tsconfig |
| lockfile/shrinkwrap 大范围漂移 | 中 | 无关依赖版本变化 | 默认只生成根 lockfile；批准的核心依赖变化单独生成并登记 |
| 上游 server/storage 引入范围膨胀 | 中 | Desktop 被迫迁 SQLite | 明确非目标；只完成工作区兼容 |
| 新事件未投影 | 中 | timeline 卡住或 sidecar wire error | event compatibility 测试和未知事件容忍策略 |
| Windows managed Bash 注入失败 | 高 | packaged Desktop 无 shell | Desktop SettingsManager override；用户优先级和 package resource smoke |

## 9. 提交切分建议

每个提交只包含一个可验证迁移主题：

1. `chore: sync pi core to v0.82.1`
2. 可选 `feat(coding-agent): expose <generic capability>`，仅用于已登记核心偏差
3. `refactor(desktop): own models config adapter`
4. `refactor(desktop): migrate auth and providers to ModelRuntime`
5. `refactor(desktop): migrate session workers to ModelRuntime`
6. `refactor(desktop): replace runtime on extension generation changes`
7. `fix(desktop): inject packaged shell through settings`
8. `refactor: adopt pi server and sqlite storage workspace`
9. `test(desktop): cover pi 0.82.1 compatibility`
10. `chore: refresh root dependency lock`

实际提交必须遵守仓库要求，只 stage 本次迁移修改的明确路径，并使用项目规定的提交消息格式。未经用户要求不要执行 commit。

## 10. 最终验收清单

### 源码和 API

- [ ] 所有 pi 核心发布包为 `0.82.1`。
- [ ] 官方核心路径相对 `v0.82.1` 没有未登记 diff。
- [ ] 每项核心偏差都有通用 API 理由、核心测试、Desktop 集成测试和 changelog。
- [ ] Desktop 不再导入 public `AuthStorage`。
- [ ] Desktop 应用层不再持有 `ModelRegistry`。
- [ ] extension context 仅使用官方兼容 `ModelRegistry`。
- [ ] Desktop 不再引用 coding-agent 私有 `findInitialModel` 或本地 thinking helper。
- [ ] Desktop 不再引用 `@earendil-works/pi-coding-agent/models-config`。
- [ ] models.json adapter 和 contracts 完全位于 Desktop。
- [ ] extension generation reload 由 Desktop runtime replacement 实现；若使用核心改动，该改动已登记且保持通用。
- [ ] managed Bash 默认通过 Desktop SettingsManager override 注入；任何核心支持均已登记且不含 Desktop 专用约定。

### 配置和数据

- [ ] `0.80.7` auth.json 可直接读取。
- [ ] `0.80.7` models.json 可直接读取并无损保存。
- [ ] JSONC 注释和未知字段保留。
- [ ] OAuth、API key、环境变量和 custom provider 均通过。
- [ ] `0.80.7` JSONL session 可恢复。
- [ ] 未发生未声明的数据格式迁移。

### 工作区和依赖

- [ ] orchestrator 已一致迁为 server。
- [ ] storage workspace 已加入但未强迫 Desktop 迁 SQLite。
- [ ] root build/check 仍覆盖 Desktop 边界。
- [ ] package-lock、install-lock、shrinkwrap 一致。
- [ ] 依赖仍精确固定，安全 override 生效。

### 验证

- [ ] 修改过的具体测试全部通过。
- [ ] `npm --prefix packages/desktop run typecheck` 通过。
- [ ] `npm run check` 通过且无 warning/info。
- [ ] `./test.sh` 通过。
- [ ] 获批后 Desktop sidecar smoke 通过。
- [ ] 获批后 Desktop GUI smoke 通过。
- [ ] Windows packaged managed Bash 验证通过。

## 11. 完成定义

满足以下条件才视为升级完成：

1. 目标 pi 核心以官方 `v0.82.1` 为基线，只包含已登记、通用且通过测试的最小偏差，不包含维持旧 Desktop 架构的补丁。
2. Desktop 的模型、认证、provider、session、extension 和 subagent 通过 Desktop adapter 运行在官方 `ModelRuntime` 架构上。
3. 现有用户配置和 JSONL 会话无需人工修改即可继续使用。
4. 所有自动化验收门通过，获批的 Desktop build/smoke 通过。
5. 风险登记中没有未接受的高严重度残余风险。
6. 升级 diff、生成制品和回滚点均可审查、可复现。
