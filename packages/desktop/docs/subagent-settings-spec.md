# Desktop 子智能体设置规范

> 状态：Draft
>
> 适用范围：`packages/desktop`，子智能体设置 UI
>
> 目标版本：Desktop v1

## 1. 目标

在 Desktop 设置中新增"子智能体"菜单和 `/settings/subagents` 子路由，提供一个结构化界面，让用户无需手动编辑 JSON / Markdown 文件即可完成以下操作：

- 查看所有可用的 subagent（内置、自定义）及其状态、模型、描述；
- 启用/禁用内置 agent；
- 覆盖内置 agent 的模型、系统提示词、工具、技能、thinking 等字段；
- 将内置 agent eject 到用户作用域，获得可编辑副本；
- 创建、编辑、删除自定义 agent；
- 创建、编辑、删除 chain（步骤式工作流）；
- 编辑 subagent 扩展全局配置（默认异步、嵌套深度、并行上限等）。

本规范不依赖 Pi session runtime，页面通过窄化的 IPC API 直接读写 `~/.pi/agent` 下的文件。

## 2. 非目标

首期不实现：

- 实时测试或预览 agent 行为；
- 与 Pi CLI settings 的双向实时同步（读写相同文件，手动切换 CLI 和 Desktop 后重新打开页面即反映）；
- 在 Electron main 或 renderer 中执行 agent discovery 的目录遍历以外的任意代码；
- 动态热加载——agent 配置变更在下次创建 thread worker 时生效；
- 拖拽排序 agent；
- 可视化 chain 编辑器（仅文本/表单编辑）；
- 批量导入/导出 agent 配置。

## 3. 现有边界

### 3.1 配置权威来源

子智能体配置的权威来源是四个文件/目录：

| 来源 | 路径 | 用途 |
|---|---|---|
| Subagent 扩展配置 | `~/.pi/agent/extensions/subagent/config.json` | `ExtensionConfig`（异步默认、深度上限等） |
| Agent settings | `~/.pi/agent/settings.json` 的 `subagents.agentOverrides` 部分 | 内置 agent override（用户级） |
| Agent settings（项目） | `<project>/.pi/settings.json` 的 `subagents.agentOverrides` 部分 | 内置 agent override（项目级） |
| 自定义 agent 目录（用户） | `~/.pi/agent/agents/*.md` | 自定义 agent 定义 |
| 自定义 agent 目录（项目） | `<project>/.pi/agents/*.md` | 自定义 agent 定义 |
| Chain 目录（用户） | `~/.pi/agent/chains/*.chain.md` | Chain 定义 |
| Chain 目录（项目） | `<project>/.pi/chains/*.chain.md` | Chain 定义 |

Agent discovery 通过 `@earendil-works/pi-coding-agent` 内建扩展 `pi-subagents` 的 `discoverAgentsAll()` 函数完成，该函数合并内置、包、用户和项目作用域的 agent。

桌面设置页通过 IPC 请求主进程执行 `discoverAgentsAll()` + `loadConfig()` + 读取 settings 文件，然后在 renderer 中展示合并后的结果。

### 3.2 与现有设置页的关系

`/settings/subagents` 与以下现有设置页并行：

- 扩展页面 (`/settings/extensions`) 控制扩展的**加载/卸载**：是否允许某个扩展进入 Desktop runtime。
- 子智能体页面控制**已加载的 subagent 扩展**的行为配置。

两者有交集但不是子集关系：subagent 扩展本身由扩展页面控制是否启用（toggle），子智能体页面在其内部配置 agent、chain 和运行参数。

### 3.3 依赖的已有组件

该页面直接复用以下现有资产：

- `pi-subagents` 扩展的 `agent-management.ts` 中的 `handleCreate`/`handleUpdate`/`handleDelete`、`discoverAgentsAll`、`saveBuiltinAgentOverride`、`removeBuiltinAgentOverride`；
- `config.ts` 中的 `loadConfig()`/`saveConfig()`；
- `types.ts` 中的 `ExtensionConfig` 类型。

不需要新增配置存储格式或重写业务逻辑。

## 4. 用户流程

### 4.1 页面入口

用户从设置左侧导航菜单点击"子智能体"进入 `/settings/subagents`。

### 4.2 Agent 列表面板

页面以大列表形式展示：

1. **内置 Agent**（只读区域，可 override）
   - 每一行显示：名称、描述摘要、当前模型、启用状态（开关）
   - 右侧操作：`编辑`（打开覆盖编辑面板）、`弹出到用户级`（eject）
   - 支持搜索/过滤

2. **自定义 Agent**（用户级 + 项目级）
   - 每一行显示：名称、描述、模型、作用域标签（user/project）
   - 右侧操作：`编辑`、`删除`
   - 底部：`+ 新建 Agent` 按钮

3. **Chain**
   - 每一行显示：名称、描述、步数、作用域标签
   - 右侧操作：`查看详情`、`编辑`、`删除`
   - 底部：`+ 新建 Chain` 按钮

4. **全局配置**
   - 折叠面板，展开后包含 ExtensionConfig 可编辑字段

### 4.3 Agent 编辑面板

点击编辑（内置覆盖或自定义）打开侧边面板或弹窗：

- **名称**（自定义 agent 可编辑，内置只读）
- **描述**（多行文本）
- **模型**（下拉框，从当前 model registry 获取可用模型列表；含搜索）
- **Fallback 模型**（多选标签输入）
- **Thinking 级别**（下拉：off / minimal / low / medium / high / xhigh / max）
- **系统提示词**（多行文本框，语法高亮可选）
- **System Prompt Mode**（单选：replace / append）
- **继承项目上下文**（开关）
- **继承技能**（开关）
- **Default Context**（下拉：fresh / fork）
- **工具**（标签输入框，`mcp:` 前缀自动识别为 MCP direct tool）
- **技能**（标签输入框，自动补全可用技能列表）
- **Turn Budget**（数字输入：maxTurns、graceTurns）
- **Tool Budget**（数字输入 + 阻断工具列表）
- **Acceptance Role**（下拉：无 / read-only / writer）
- **Completion Guard**（开关）
- **启用状态**（开关）

保存操作对应不同的底层写入：

- 覆盖内置 agent → 写入 `settings.json` 的 `subagents.agentOverrides.<name>`
- 创建/更新自定义 agent → 写入 `~/.pi/agent/agents/<name>.md`
- eject → 先读取内置 agent 定义，序列化为 Markdown 写入用户 agents 目录

### 4.4 Chain 编辑面板

Chain 编辑采用步骤列表形式：

- 每个步骤一行，显示：序号、agent 名称、task 摘要
- 每步可展开编辑：agent（下拉）、task（多行文本）、output、reads、model、skills、progress 等
- 支持添加/删除步骤、拖拽排序（纯列表，不采用可视化图编辑器）
- 底部：保存/取消

Chain 序列化为 `*.chain.md`（YAML frontmatter + steps 列表）或 `*.chain.json`。

### 4.5 全局配置面板

折叠面板中的字段：

| 字段 | 类型 | 默认值 |
|---|---|---|
| 默认异步执行 | `boolean` | false |
| 显示异步运行 widget | `boolean` | true |
| 最大嵌套深度 | `number` | 1 |
| 每 session 最大 spawn 数 | `number` | 0（不限） |
| 全局并行上限 | `number` | 20 |
| Tool 描述模式 | `full / compact` | full |
| 产物目录 | `project / session / temp` | project |
| 定时运行 | `boolean` | false |

## 5. IPC 协定

### 5.1 `window.desktop.subagents` API

在主进程的 `DesktopApi` 中新增 `subagents` 命名空间：

```typescript
interface DesktopApi {
  // ... existing fields ...
  subagents: {
    getSnapshot(input: {
      projectId?: string;
    }): Promise<SubagentSettingsSnapshot>;

    saveConfig(input: {
      requestId: string;
      expectedSnapshotRevision: string;
      mutation: SubagentSettingsMutation;
    }): Promise<SaveSubagentSettingsResult>;
  };
}
```

### 5.2 Snapshot 类型

```typescript
interface AgentSummary {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  source: "builtin" | "user" | "project" | "package";
  filePath: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  disabled?: boolean;
  defaultAsync?: boolean;
  defaultTimeoutMs?: number;
  tools?: string[];
  mcpDirectTools?: string[];
  skills?: string[];
  /** Present only when an override is active (for builtins). */
  overridden?: boolean;
  overrideScope?: "user" | "project";
  /** The base config before override (for builtins). */
  baseModel?: string;
}

interface ChainStepSummary {
  agent: string;
  task?: string;
  phase?: string;
  label?: string;
  output?: string | false;
  model?: string;
}

interface ChainSummary {
  name: string;
  description: string;
  source: "user" | "project" | "package";
  filePath: string;
  steps: ChainStepSummary[];
  stepCount: number;
}

interface SubagentSettingsSnapshot {
  revision: string;
  extensionConfig: ExtensionConfig;
  builtinAgents: AgentSummary[];
  userAgents: AgentSummary[];
  projectAgents: AgentSummary[];
  chains: ChainSummary[];
  defaultModel?: AgentModelSourceInfo;
  diagnostics: DesktopExtensionDiagnostic[];
}
```

### 5.3 Mutation 类型

```typescript
type SubagentSettingsMutation =
  // Agent mutations
  | {
      type: "update-agent";
      agent: string;
      scope: "user" | "project";
      config: Partial<AgentConfig>;
    }
  | {
      type: "create-agent";
      scope: "user" | "project";
      config: {
        name: string;
        description: string;
        model?: string;
        systemPrompt?: string;
        // ... other AgentConfig fields
      };
    }
  | {
      type: "delete-agent";
      agent: string;
      scope: "user" | "project";
    }
  | {
      type: "eject-agent";
      agent: string;
      scope: "user" | "project";
    }
  // Builtin agent overrides
  | {
      type: "set-agent-enabled";
      agent: string;
      disabled: boolean;
    }
  // Chain mutations
  | {
      type: "create-chain";
      scope: "user" | "project";
      config: {
        name: string;
        description: string;
        steps: ChainStepConfig[];
      };
    }
  | {
      type: "update-chain";
      chain: string;
      scope: "user" | "project";
      config: Partial<{
        name: string;
        description: string;
        steps: ChainStepConfig[];
      }>;
    }
  | {
      type: "delete-chain";
      chain: string;
      scope: "user" | "project";
    }
  // Extension config mutations
  | {
      type: "update-extension-config";
      config: Partial<ExtensionConfig>;
    };
```

## 6. 数据流

### 6.1 加载

```text
Renderer
  → window.desktop.subagents.getSnapshot({ projectId })
    → IPC handler
      → SubagentSettingsConfigService.getSnapshot()
        → pi-subagents discoverAgentsAll(cwd)
        → pi-subagents loadConfig()
        → read settings.json subagents.agentOverrides
      → return SubagentSettingsSnapshot
    → Renderer 渲染列表
```

### 6.2 保存（以覆盖内置 agent 模型为例）

```text
用户点击保存
  → Renderer 构造 mutation:
    { type: "update-agent", agent: "reviewer", scope: "user", config: { model: "claude-opus-4" } }
  → window.desktop.subagents.saveConfig({ requestId, expectedRevision, mutation })
    → IPC handler
      → SubagentSettingsConfigService.mutate()
        → pi-subagents saveBuiltinAgentOverride(cwd, "reviewer", "user", { model: "claude-opus-4" })
          → 写 ~/.pi/agent/settings.json 的 subagents.agentOverrides.reviewer
      → 重新 getSnapshot()
      → return { status: "saved", snapshot }
  → Renderer 更新列表
```

## 7. 路由和导航

### 7.1 新增路由

```typescript
// packages/desktop/src/renderer/src/app/routes/settings.subagents.tsx
import { SubagentSettingsPage } from "@renderer/features/settings/subagent-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/subagents")({
  component: SubagentSettingsPage,
});
```

### 7.2 侧边栏菜单

在 `settings-page.tsx` 的导航菜单中新增：

```typescript
<Link to="/settings/subagents" search={search} className="settings-menu-item" activeOptions={{ exact: true }}>
  <GitFork />  {/* or Users, or Cpu */}
  <span>子智能体</span>
</Link>
```

使用 `lucide-react` 中 `GitFork` (`lucide-react/dist/esm/icons/git-fork.mjs`) 或 `Cpu` 图标。

## 8. 文件变更清单

| 文件 | 变更 | 估算行数 |
|---|---|---|
| `packages/desktop/src/shared/subagent-contracts.ts` | 新增 SubagentSettingsSnapshot、Mutation 等类型 | ~100 |
| `packages/desktop/src/shared/desktop-api.ts` | `DesktopApi` 新增 `subagents` 字段 | ~10 |
| `packages/desktop/src/main/subagents/subagent-settings-config-service.ts` | 新建：`SubagentSettingsConfigService` 类 | ~180 |
| `packages/desktop/src/main/ipc.ts` | 注册 subagents IPC handlers | ~20 |
| `packages/desktop/src/main/index.ts` | 初始化 SubagentSettingsConfigService | ~5 |
| `packages/desktop/src/renderer/src/features/settings/use-subagent-settings-controller.ts` | 新建：React hook | ~60 |
| `packages/desktop/src/renderer/src/features/settings/subagent-settings-page.tsx` | 新建：页面主体组件 | ~600 |
| `packages/desktop/src/renderer/src/app/routes/settings.subagents.tsx` | 新建：路由 | ~15 |
| `packages/desktop/src/renderer/src/app/routes/settings.tsx` | 注册 subagents 子路由（已由 file-based routing 自动处理） | 0 |
| `packages/desktop/src/renderer/src/features/settings/settings-page.tsx` | 导航菜单增加链接 | ~5 |
| `packages/desktop/src/renderer/src/styles/layout.css` | 新增 subagent 页面专用样式（如有） | ~50 |

总计约 **1050 行新增代码**。

## 9. 验收标准

### 9.1 功能验收

1. 打开 `/settings/subagents` 能展示所有内置 agent（reviewer、worker、planner、oracle、researcher、scout、context-builder、advisor、delegate）
2. 能看到 agent 的模型、描述、启用状态
3. 切换内置 agent 启用状态后重新打开页面，状态持久化
4. 覆盖内置 agent 模型后重新打开，模型字段显示覆盖值
5. 创建自定义 agent 后出现在自定义列表中，能被 Pi subagent tool 使用
6. 删除自定义 agent 后列表更新，对应文件被删除
7. Eject 内置 agent 后用户 agents 目录出现同名 `.md` 文件
8. 创建/编辑/删除 chain 后列表同步更新
9. 修改全局配置（如`maxSubagentDepth`）后写入 `config.json`，页面重新打开显示最新值
10. 编译：`npm run check` 无错误

### 9.2 边界验收

1. 内置 agent 名不可编辑（名称字段禁用）
2. 重名自定义 agent 在相同 scope 下不允许创建
3. 未设置模型的自定义 agent 显示"继承当前会话模型"
4. 模型选择框只展示当前 model registry 中可用的模型
5. 外部修改 `settings.json` 或 `config.json` 后，页面 revision 不匹配时写操作返回 conflict
6. 项目级 override 优先级高于用户级 override

### 9.3 非功能验收

1. IPC 调用不依赖 Pi session runtime
2. 设置页不在 renderer 中拼接 home 路径，全部通过主进程 `getAgentDir()` 解析
3. 页面加载时无网络请求
4. Agent 编辑面板支持键盘导航（Tab、Enter、Escape）
