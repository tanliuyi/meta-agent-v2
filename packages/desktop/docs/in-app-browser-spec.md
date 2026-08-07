# Desktop 内置浏览器（In-App Browser）规范

状态：Draft
最后更新：2026-08-06
适用范围：`packages/desktop`

## 1. 目标

Desktop 提供内置浏览器（下文简称 IAB），用户与 Agent 共享同一页面视图：

- 用户可以在应用内打开网页、本地开发服务器页面，直接看到渲染结果。
- Agent（Pi runtime）可以把浏览器作为工具使用：打开页面、点击、输入、滚动、截图、读取结构化页面快照，并验证操作结果。
- 浏览器使用独立 profile（独立 Electron session partition），与应用主 session 和日常浏览器完全隔离。
- 参考实现：OpenAI Codex / ChatGPT Desktop 的 In-App Browser（Electron `<webview>` 标签 + 主进程 CDP 控制），已通过官方文档、逆向文档与 issue 日志交叉确认其架构。

## 2. 背景与技术选型

### 2.1 参考对象：Codex IAB

Codex Desktop（Electron 42）IAB 已确认的技术事实：

- Renderer 创建 `<webview>` 标签（日志 `renderer created browser sidebar webview`、`did-attach-webview`），有用户可见 sidebar webview 与隐藏 `hostKind=hidden-browser-use` 执行 webview 两种形态。
- 独立 partition `codex-browser-app`（`.../web/Codex/Default/Partitions/codex-browser-app`），独立 profile。
- Main 进程 `BrowserSidebarManager`（"In-app browser, CDP input"）通过 CDP（`webContents.debugger`）控制 guest webContents；日志含 `registered debugger listener` / `unregistered debugger listener reason=target-close`。
- Agent 工具层为 browser-use 插件（`openai-bundled/browser-use`），API 形态：`setupAtlasRuntime({ backend: 'iab' })`、`agent.browser.tabs.selected()/new()`、`tab.goto(url, {waitUntil, timeout})`、`tab.playwright.domSnapshot()`（playwright 风格结构化快照）。
- 工具定义是 skill + node_repl MCP 双层：插件挂载 Browser skill（CLI TUI 同样挂载），执行载体是 `node_repl` MCP 工具（bootstrap 依赖它，见 #33599/#25247）；完整运行时 API 含 `tab.dom_cua.get_visible_dom()`（computer use 可见 DOM）与 `tab.screenshot()`（#31384 还原）。工具发现存在已知缺陷：独立 `playwright-mcp`/`chrome-devtools-mcp` 会抢占发现，把 agent 路由到错误的浏览器会话（#31384）。
- 人机交互：站点级 allow/block 列表（未允许站点 agent 使用前询问）；敏感操作（提交信息/购买/改权限/删除）确认；不能自动化文件上传；agent 可等待用户登录后继续；Browser Use 会话有 PiP 可视反馈；full CDP 需 Developer mode 显式开关 + 每次使用前批准。
- 标注（annotation）：Annotation mode + overlay 层（hover 蓝色预览矩形 → 点击/拖拽选区 → 写注释），commit 时从实际元素取 bounds；注释运行时在 webview preload（`comment-preload.js`：IPC bridge + host message queue + navigation hooks），导航后队列保持；Adjust 模式可给字体/间距/颜色等样式微调反馈。
- 已知问题：Windows 上大量主进程级 `chrome.dll` 崩溃（webview 导航/teardown/PiP 时，use-after-free 特征），`did-attach-webview` 回调内同步 `loadURL` 是已确认触发器之一；partition 持久化状态损坏也会触发崩溃。

### 2.2 选型决策

- **D1（宿主）**：采用 Electron `<webview>` 标签，由 renderer 创建，参考 Codex IAB。`<webview>` 是官方"不推荐但可用"API（Chromium webview 架构重构中），本规范第 12 节强制崩溃恢复与稳定性措施，并保留 D1.1 退路。
- **D1.1（退路）**：CDP 控制层与 tab 模型必须与宿主解耦（接口化）；若 webview 稳定性不可接受，可无缝迁移到 `WebContentsView`（控制层代码复用，仅换宿主与事件源）。
- **D2（隔离）**：webview 使用独立 session `partition="persist:browser"`，登录态、cookie、缓存与应用主 session 隔离；可在设置页清除。
- **D3（控制通道）**：主进程通过 `webContents.debugger`（CDP）控制 guest webContents：`Page.navigate`、`Runtime.evaluate`、`Input.dispatchMouseEvent/insertText`、`Page.captureScreenshot`、`Accessibility.getFullAXTree`。
- **D4（Agent 集成）**：浏览器工具注册为 builtin desktop extension（`pi-browser`，capability `tools.register`），工具执行经 IPC 路由到主进程 BrowserManager，与现有 pi-auto-title / pi-subagents 的 extension 模式一致。
- **D5（感知）**：Agent 感知页面使用"简化 AX 树 + 可交互元素编号 + 截图"组合（browser-use DomService 模式）：快照树喂文本模型，截图喂视觉模型，交互通过编号定位。
- **D6（共享视图）**：P0/P1 只做单一共享视图（用户所见 == Agent 所见）；隐藏执行视图（Codex 的 `hidden-browser-use`）作为 P2 可选增强。
- **D7（工具契约与生态对照）**：工具契约参照 pi 生态 `pi-agent-browser-native` 的 TOOL_CONTRACT（语义动作简写、`@ref` 编号、spill file、stale ref 恢复提示）；无头浏览器路径（`pi-agent-browser-native` / `pi-mcp-adapter` + `chrome-devtools-mcp`）作为备案，不与内置共享视图混用，避免 Codex #31384 式的工具发现路由冲突。

## 3. 系统架构

```text
Renderer (React SPA)
  Browser 面板路由（/browser 或侧边栏）
    ├─ 地址栏 / tab 条 / 控制按钮（React 组件）
    └─ <webview partition="persist:browser">（页面视图，含事件与状态绑定）
            │ did-attach-webview → IPC 通知 main（attach token）
Preload (contextBridge)
  window.desktopApi.browser.*（invoke）+ browserStateChanged 事件订阅
Main process
  BrowserManager（src/main/browser/browser-manager.ts）
    ├─ TabRegistry：tabId ↔ webContentsId ↔ URL/title/loading 状态
    ├─ CdpSession：debugger attach/detach、请求串行队列、超时
    ├─ 动作执行：navigate / click / type / scroll / back / forward / reload / snapshot / screenshot
    ├─ 事件源：did-navigate / page-title-updated / did-start-loading / did-stop-loading / render-process-gone
    └─ Session 策略：setPermissionRequestHandler / setWindowOpenHandler / will-download / will-navigate
Agent 侧
  pi-browser extension（src/main/pi/extensions/pi-browser/）
    ├─ tools.register：browser_* 工具集（JSON schema）
    └─ 执行：经 BrowserManager 内部接口（同进程直接调用，不经 IPC）
```

关键说明：

- webview 标签由 renderer 持有，但 guest `webContents` 实例归属 main。renderer 通过 `did-attach-webview`（标签事件，携带 `webContentsId`）通知 main 注册；main 用 `webContents.fromId()` 取得 guest 并执行 CDP。
- Agent 工具执行在 main 进程内直接调用 BrowserManager（extension 与 BrowserManager 同属 main），无需额外 IPC 往返；Renderer 仅通过事件流获得状态更新。
- 不引入独立浏览器进程或 Playwright；不引入 named pipe / app-server（Codex 的 Rust 层在本架构中由 BrowserManager 直接承担）。

## 4. Renderer：浏览器面板

### 4.1 入口与布局

- 入口：左侧面板 tab（与终端/文件面板并列）或独立路由 `/browser`；首次使用可提示快捷键（参考 Codex `Cmd/Ctrl+Shift+B`）。P0 已注册为 workbench 面板 tab（kind `browser`，可 addable 添加）。
- 布局：顶部工具条（返回/前进/刷新/地址栏/新 tab/清除数据入口）+ tab 条 + `<webview>` 主视图。
- 页面状态与 `<webview>` 事件绑定：`did-start-loading`/`did-stop-loading` → loading 指示；`page-title-updated` → tab 标题；`did-navigate`/`did-navigate-in-page` → 地址栏 URL 同步；`render-process-gone`/`did-crash` → 崩溃态 UI（自动重建按钮）。
- 会话/窗口生命周期：窗口关闭时保留 tab 集合（内存态），重启后可恢复 tab 列表与 URL（持久化设置见第 9.3 节）。
- **P0 面板生命周期语义**：workbench 面板切换会卸载本面板（与 files 面板一致），卸载即销毁全部 webview/tab；P0 实现为卸载时快照各 tab URL、重新挂载时恢复 tab 列表并重新导航（状态不跨面板会话保留，仅 URL）。keep-alive（display:none 保活 webview）或状态提升到模块级 store 列入 P1。

### 4.2 webview 标签约束

```html
<webview
  src="about:blank"
  partition="persist:browser"
  data-browser-view
  allowpopups="false"
  webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
/>
```

- `allowpopups="false"`：`window.open`/`target=_blank` 由 main 的 `setWindowOpenHandler` 统一转新 tab（D3）。
- 不设置 webview preload（注释功能 P2 可选时再引入，参考 Codex comment-preload.js）。
- 禁止在 `did-attach-webview` 回调中同步导航（第 12 节 S1）。

## 5. Preload API

在现有 `window.desktopApi` 上新增 `browser` 命名空间（`src/preload/index.ts`），全部经 `ipcRenderer.invoke`：

```ts
interface DesktopApiBrowser {
  tabsList(): Promise<BrowserTab[]>;
  tabOpen(url?: string): Promise<BrowserTab>;
  tabClose(tabId: number): Promise<void>;
  tabSelect(tabId: number): Promise<BrowserTab | null>;
  navigate(tabId: number, url: string): Promise<BrowserNavigateResult>;
  snapshot(tabId: number, opts?: { withScreenshot?: boolean }): Promise<BrowserSnapshot>;
  screenshot(tabId: number): Promise<{ dataUrl: string } | { error: string }>;
  action(tabId: number, action: BrowserAction): Promise<BrowserActionResult>; // click/type/scroll/back/forward/reload
  getSettings(): Promise<BrowserSettings>;
  saveSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings>;
  clearData(): Promise<void>;
  onStateChanged(cb: (event: BrowserStateEvent) => void): () => void; // 订阅 browserStateChanged
}
```

## 6. Main：BrowserManager

文件：`src/main/browser/browser-manager.ts`（服务类，由 `src/main/index.ts` 创建并注入 ipc.ts 与 pi-browser extension）。

### 6.1 TabRegistry

- `tabId`（自增）↔ `webContentsId` ↔ `{ url, title, loading, favicon?, crashed, createdAt }`。
- tab 创建：renderer 创建新 `<webview>` → attach 事件携带 `webContentsId` → main 注册并返回 `tabId`；或 main 主动要求 renderer 创建（`tabOpen` IPC → main 通知 renderer 渲染新 webview → attach → 回填）。
- tab 关闭：renderer 移除 `<webview>` → main 清理注册、detach CDP。
- 单活跃 tab：`tabSelect` 切换 renderer 侧可见 webview，CDP 只 attach 活跃 tab（避免多 attach 冲突）。

### 6.2 CdpSession（控制层，宿主无关）

接口化（D1.1 退路的边界）：

```ts
interface BrowserHostController {
  attach(webContentsId: number): Promise<void>;
  detach(): Promise<void>;
  navigate(url: string): Promise<{ url: string; error?: string }>;
  evaluate(expression: string): Promise<unknown>;
  clickAtPoint(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  scrollBy(dx: number, dy: number): Promise<void>;
  getSnapshot(): Promise<{ axTree: unknown; meta: { url: string; title: string } }>;
  captureScreenshot(): Promise<string>; // base64 PNG
  goBack(): Promise<void>; goForward(): Promise<void>; reload(): Promise<void>;
  onEvent(cb: (event: BrowserHostEvent) => void): () => void;
}
```

- 实现基于 `webContents.debugger`：`attach("1.3")` 后 `sendCommand(method, params)`；`detach()` 时静默失败。
- 所有 `sendCommand` 包统一超时（默认 10s，可配置）与单命令串行队列；拒绝并发（同 tab 内）。
- CDP 事件（`debugger.on("message")`）转为 `BrowserHostEvent`：`Page.frameNavigated` → 导航完成、`Inspector.targetCrashed` → crashed。

### 6.3 动作执行语义

| 动作 | CDP 映射 | 说明 |
|---|---|---|
| navigate | `Page.navigate` | 等待 `domcontentloaded` 或超时返回；不等待网络 idle |
| click(index) | snapshot 时记录元素中心点 → `Input.dispatchMouseEvent(mousePressed/mouseReleased)` | 真实输入事件；失败回退 `Runtime.evaluate` 执行 `el.click()` |
| type(index, text) | `Runtime.evaluate` focus 元素 → `Input.insertText` | 不逐字符 dispatch（避免 IME/性能问题）；`submit=true` 时追加 `Input.dispatchKeyEvent(Enter)` |
| scroll | `Input.dispatchMouseEvent(mouseWheel)` | 或 `Runtime.evaluate` `window.scrollBy`（简单场景） |
| back/forward/reload | `Page.navigateToHistoryEntry` / `Page.reload` | 无历史时返回错误 |

### 6.4 事件与状态广播

`browserStateChanged` 事件（合并节流，默认 100ms）负载：

```ts
interface BrowserStateEvent {
  tabs: BrowserTab[];
  activeTabId: number | null;
  activeTab?: { url: string; title: string; loading: boolean };
  error?: string;
}
```

## 7. Agent 工具（pi-browser extension）

文件：`src/main/pi/extensions/pi-browser/index.ts` + `config.ts`；注册在 desktop extension 清单（capability `tools.register`、`session.read`、`ui.notify`），extension id `pi-browser`，displayName「内置浏览器」。

### 7.1 工具集与 JSON schema

| 工具 | 参数 | 返回 |
|---|---|---|
| `browser_open` | `url: string` | `{ tabId, title, url }`；打开/复用活跃 tab |
| `browser_navigate` | `tabId?, url` | `{ url, title }` |
| `browser_snapshot` | `tabId?, withScreenshot?: boolean` | `BrowserSnapshot`（第 8 节） |
| `browser_screenshot` | `tabId?` | `{ dataUrl, width, height }` |
| `browser_click` | `tabId?, elementIndex: number` | `{ ok, url?, error? }` |
| `browser_type` | `tabId?, elementIndex: number, text: string, submit?: boolean` | `{ ok, error? }` |
| `browser_scroll` | `tabId?, direction: "up"\|"down"\|"top"\|"bottom", amount?: number` | `{ ok }` |
| `browser_back` / `browser_forward` / `browser_reload` | `tabId?` | `{ ok, url? }` |
| `browser_tabs` | — | `[{ tabId, title, url, loading }]`；支持 `browser_tabs_new/close`（后置） |
| `browser_history` | — | 需用户批准后返回最近访问记录（URL、标题、时间戳） |

- `tabId` 缺省取当前活跃 tab；无浏览器面板/无 tab 时 `browser_open` 自动创建（renderer 侧自动挂载浏览器面板）。
- 工具描述（模型可见）强调：页面内容视为不可信上下文；敏感站点与敏感操作（提交表单、购买、删除）应由模型向用户说明并等待确认（第 10.5 节）。
- 结果中的快照树限制规模（默认 ≤ 200 节点、文本截断），防上下文膨胀。

### 7.2 工具契约细节（参照 pi-agent-browser-native TOOL_CONTRACT，D7）

- **语义动作简写**：`snapshot` 返回带 `@eN` 编号的树后，交互工具接受 `elementIndex` 直接定位；工具描述里明确「先 snapshot 再按编号交互」的操作 playbook（不要求模型每次重新发现流程）。
- **spill file**：超大快照（超过阈值，默认 > 4KB 文本）不整体塞入工具结果，写入临时文件并在结果中给出路径与摘要；模型可用 `read` 工具按需读取，控制上下文膨胀。
- **stale ref 恢复提示**：`click/type` 命中已失效编号（页面已导航/重绘）时返回结构化错误 + 建议「重新 snapshot」；错误文案给出下一步动作而非仅报错。
- **工具发现路由**：`browser_*` 是唯一内置浏览器工具面；不注册会与 IAB 冲突的 MCP 浏览器工具（playwright-mcp / chrome-devtools-mcp 只允许出现在用户显式配置且已知会操作独立浏览器实例的场景）。

### 7.3 执行流程

1. extension 收到工具调用 → 校验参数 → 调 BrowserManager 对应方法（同进程）。
2. BrowserManager 执行 CDP → 结果回传 extension → 写入工具结果（含 snapshot 树文本 + 可选截图 dataUrl，供 assistant-ui ToolView 渲染卡片）。
3. 失败（超时/崩溃/无 tab）：返回结构化错误，不影响会话；工具调用标记 error，模型可重试。

### 7.4 工具卡片渲染（assistant-ui）

- ToolView 对 `browser_*` 工具渲染专用卡片：URL、标题、快照摘要、截图缩略图（可点击放大）、loading/完成/错误三态。
- 卡片数据来自工具结果 JSON，不新增 IPC；遵循现有 tool-group 的展开/折叠与光标契约。

## 8. DOM 快照格式（BrowserSnapshot）

由 `Accessibility.getFullAXTree` 简化而来（browser-use DomService 思路）：

```ts
interface BrowserSnapshot {
  url: string;
  title: string;
  timestamp: number;
  viewport: { width: number; height: number; dpr: number };
  tree: BrowserSnapshotNode[];
  screenshot: string | null; // data:image/png;base64, 仅 withScreenshot=true
}

interface BrowserSnapshotNode {
  index?: number;          // 可交互元素全局编号（从 1 开始，跳过不可交互）
  role: string;            // AX role：button/link/textbox/checkbox/combobox/navigation/main/heading/...
  name: string;            // accessible name（截断 ≤ 120 字符）
  value?: string;          // 输入框当前值（截断）
  tag: string;             // 底层标签：a/button/input/textarea/select/...
  attrs?: { href?: string; type?: string; checked?: boolean; selected?: boolean };
  center?: { x: number; y: number }; // 视口内坐标，click 用
  children?: BrowserSnapshotNode[];
}
```

- 简化规则：跳过不可见/离屏/纯样式节点；折叠仅含单文本子树的节点；`textbox` 等默认 `value` 为空时省略；iframe 内 AX 树并入（`Accessibility.getFullAXTree` 支持跨 frame 一次拉取）。
- 编号规则：仅对可交互元素（button/link/textbox/combobox/checkbox/radio/menuitem 等）编号；文本模型只需引用编号即可定位。
- 截图：`Page.captureScreenshot`（`fromSurface: true`）或 `webContents.capturePage()`；默认不随快照返回，模型显式请求时才包含（控制 token 成本）。
- P1 可选增强：注入式高亮编号 overlay（browser-use python_highlights 做法），让用户视觉与模型编号一致；实现为 renderer 侧叠加层（经 snapshot 的 center 坐标绘制），不注入页面 DOM。

## 9. IPC 契约

### 9.1 频道（`src/shared/channels.ts` 新增）

P0 已实现（renderer 驱动的 attach/detach 模型）：

```ts
browserAttach: "desktop:browser:attach",        // renderer 上报 guest webContentsId → tabId
browserDetach: "desktop:browser:detach",        // renderer 移除 webview 时注销
browserTabSelect: "desktop:browser:tab-select",
browserNavigate: "desktop:browser:navigate",
browserScreenshot: "desktop:browser:screenshot",
browserSettingsGet: "desktop:browser:settings-get",
browserSettingsSave: "desktop:browser:settings-save",
browserClearData: "desktop:browser:clear-data",
browserStateChanged: "desktop:browser:state-changed",
```

P1 增加（spec §5 原草案形状）：`browserTabsList`、`browserTabOpen/Close`、`browserSnapshot`、`browserAction`、`browserOpenPanel`（工具首次使用拉起面板）。

### 9.2 契约类型（`src/shared/browser-contracts.ts` 新增）

`BrowserTab`、`BrowserSnapshot`、`BrowserSnapshotNode`、`BrowserAction`（判别联合：click/type/scroll/back/forward/reload）、`BrowserActionResult`、`BrowserNavigateResult`、`BrowserSettings`、`BrowserStateEvent`（见第 6.4 节）。

### 9.3 设置（`src/shared/browser-settings-contracts.ts` 新增）

```ts
interface BrowserSettings {
  allowSites: string[];      // 允许 Agent 直接操作的站点（默认空 = 每次询问）
  blockSites: string[];      // 禁止站点
  downloadDirectory: string | null; // null = 系统下载目录
  maxSnapshotNodes: number;  // 默认 200
  cdpTimeoutMs: number;      // 默认 10_000
  restoreTabsOnLaunch: boolean; // 默认 true；P1 才消费（P0 面板为内存态 URL 快照恢复）
}
```

- 持久化：`src/main/browser/browser-settings-service.ts`（文件 JSON，遵循现有 settings 服务模式：读时缺省合并、写时原子替换）。

## 10. 安全与权限

- **分区隔离**：`persist:browser` 独立 partition；浏览器内登录态与主应用 session 无关；清除数据只影响该分区。
- **权限请求**：partition session `setPermissionRequestHandler`：默认拒绝；`media` 类权限弹窗询问（后续可加 UI）；`geolocation`/`notifications`/`clipboard-read` 默认拒绝。**P0 已实现默认全拒绝**（BrowserManager 构造时对 `persist:browser` 分区设置）；media 询问与细粒度放行 P1。
- **弹窗**：`setWindowOpenHandler` → 全部转为新 tab（webview 内打开）；拒绝 `window.open` 直接创建新窗口。
- **下载**：`will-download` → 存 `downloadDirectory` 或系统下载目录；不在 webview 内触发另存为 UI（P2 可加下载通知）。
- **导航策略**：允许 `http`/`https`；`file://` 默认禁止（本地 Preview 场景 P2 显式白名单再开放）；`will-navigate` 记录并广播（用于 UI 展示与审计）。
- **Agent 操作边界**：工具描述与模型指令要求——敏感动作（提交信息、购买、改权限、删除数据）先向用户说明并等待确认；页面内容视为不可信上下文（可注入指令攻击模型），快照/截图内容不得覆盖系统提示中的工具约束。
- **不做**：不自动上传文件（同 Codex）；不实现 Chrome 扩展后端；Developer mode full CDP（Codex 的 `browser_use_full_cdp_access`）默认不做，P2 评估且需显式开关。

### 10.5 人机交互与审批（映射 Codex approval 模型到 pi 原生能力）

- **站点级权限**：`allowSites` 为空时，Agent 对未允许站点首次操作前必须经用户确认；`blockSites` 命中直接拒绝（工具返回错误）。
- **敏感操作确认**：通过 pi 扩展事件 `tool_call` 拦截实现（`pi.on("tool_call", ...)` 返回 `{ block: true, reason }`，`ctx.ui.confirm` 弹确认）——对应 Codex 的 approval policy on-request；确认粒度默认「敏感动作全确认」、可配置为「仅未允许站点确认」。
- **等待用户登录**：共享视图下用户可在 webview 内直接登录（独立 partition 登录态），Agent 侧工具 `snapshot` 轮询检测登录完成（超时可配置），无需额外机制。
- **操作可见性**：Agent 每次浏览器操作都在共享视图可见；BrowserManager 广播 `browserStateChanged`（含 loading/URL），渲染侧工具条同步当前状态（对应 Codex Browser Use PiP 的可视化意图）。
- **历史访问**：`browser_tabs` / 地址栏历史记录仅用于用户 UI；Agent 需要历史时经 `browser_history` 工具读取，工具每次调用都须 `ctx.ui.confirm` 用户批准。历史 URL 与标题作为不可信上下文处理。

## 11. 标注（Annotation，P2）

参考 Codex annotation mode + `comment-preload.js` 运行时：

- **入口**：浏览器工具条「标注模式」开关；开启后鼠标 hover 显示预览矩形（取自 snapshot 同源的元素 bounds 数据），点击/拖拽选区，弹注释编辑框（文本 + 可选的 Adjust 样式微调字段）。
- **运行时**：标注 overlay 由宿主 renderer 绘制，**不引入 guest preload**；元素拾取与重定位经 main 的 BrowserManager → CDP `Runtime.evaluate` 完成，注释数据存 main 的 tab 注册表，导航/刷新后按稳定选择器重新解析 bounds。
- **数据流**：用户保存标注 → 作为一条带元素信息、稳定选择器和页面 URL 的 composer quote 直接追加到当前 thread composer；用户随后按普通 composer 流程编辑并发送。composer 尚未挂载时由 renderer 的 session 定向桥接队列暂存，重新挂载后消费；不再提供独立的“提交给 Agent”按钮，也不直接调用 `messages.enqueue`。
- **坐标一致性**：overlay 使用与 snapshot `center` 相同的坐标变换（视图缩放适配，规避 Codex #24203 hover/commit 两套变换的 bug）；标注绑定元素（选择器 + bounds），不绑定一次性坐标。
- **约束**：标注 overlay 只在标注模式启用时挂载，不影响普通浏览与 CDP 操作；注释文本视为不可信输入参与上下文。

## 12. 稳定性与崩溃恢复（webview 已知风险对策）

参考 Codex 的 Windows 崩溃系列（#30178/#32040/#34239），本方案强制以下措施：

- **S1**：禁止在 `did-attach-webview` 回调内同步导航；attach 后下一个 macrotask 再 `loadURL`（Codex 已确认的崩溃触发器）。
- **S2**：webview 标签监听 `render-process-gone`/`did-crash`/`did-fail-load` → 标记 tab `crashed`，UI 显示崩溃态 + 一键重建；Agent 侧工具返回结构化错误。
- **S3**：partition 数据可清除（设置页「清除浏览数据」）；检测到分区持久化状态损坏（attach 失败/反复崩溃）时自动重置该 partition（Codex 实验证明清空 partition 可恢复）。
- **S4**：CDP 请求统一超时 + 每 tab 串行队列；`detach()` 幂等；tab 关闭时先 detach 再销毁 webview（Codex teardown 崩溃点之一）。
- **S5**：webview 崩溃只影响浏览器工具，绝不级联会话：所有 BrowserManager 调用 try/catch，异常仅在工具结果中呈现；主进程层面不做 `app.relaunch`。
- **S6**：若 P0/P1 实测 webview 稳定性不可接受（主进程崩溃复现），启用 D1.1 退路迁移 WebContentsView；迁移成本被第 6.2 节接口化约束在宿主实现内。

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 原型 | Browser 面板（webview + 地址栏 + tab 条）+ BrowserManager（TabRegistry + CdpSession 的 navigate/screenshot/事件）+ IPC 契约 + 设置服务骨架 | 应用内打开 `http://localhost:*` 与公网页，地址栏/标题/loading 同步，崩溃重建可用 |
| P1 工具化 | pi-browser extension（open/navigate/snapshot/click/type/scroll/back）+ 编号快照 + 工具卡片渲染 + 权限/弹窗/下载策略 | Agent 可完成"打开本地页面 → 读取快照 → 点击/输入 → 截图"闭环，工具卡片正确渲染 |
| P2 打磨 | 多 tab 工具、历史/地址栏搜索、清除数据 UI、站点 allow/block 设置、崩溃恢复强化、标注模式（第 11 节）、编号高亮 overlay | 全量边界检查 + `npm run check` 通过；Windows 实机验证稳定性 |

## 14. Out of scope（本规范明确不做）

- Chrome 扩展后端（Codex `@Chrome` 的对应物）。
- 云端/无头浏览器（Operator 模式）与独立浏览器进程；`pi-agent-browser-native` / `pi-mcp-adapter` 无头路径仅备案，不内置（D7）。
- 文件上传自动化。
- Developer mode full CDP 访问。
- 多 profile / 多用户浏览器数据。

## 15. 当前实现文件

（P0/P1 实际落地清单，2026-08-06）

```text
packages/desktop/docs/in-app-browser-spec.md            # 本规范（含 §16 交接记录）
packages/desktop/src/shared/browser-contracts.ts        # P0/P1 契约（tab/快照/动作/建 tab 请求）
packages/desktop/src/shared/browser-settings-contracts.ts# 设置契约 + normalize/validate
packages/desktop/src/shared/browser-site-policy.ts      # 站点策略纯函数（host 匹配/解析/校验）
packages/desktop/src/shared/channels.ts                 # browser* 频道
packages/desktop/src/shared/desktop-api.ts              # desktopApi.browser 域
packages/desktop/src/main/browser/browser-manager.ts    # TabRegistry + openTab + navigate/snapshot/action/back/forward/reload
packages/desktop/src/main/browser/browser-host-controller.ts # 宿主接口 + webContents/CDP 实现 + AX 纯函数
packages/desktop/src/main/browser/browser-host-server.ts# sidecar RPC（127.0.0.1 + token，§16.3）
packages/desktop/src/main/browser/browser-settings-service.ts # 设置持久化（仿 auto-title）
packages/desktop/src/main/pi/extensions/pi-browser/     # pi-browser extension（12 工具 + client + snapshot 渲染）
packages/desktop/src/main/pi/extensions/pi-browser/lib/site-access.ts # 站点访问控制器（§17）
packages/desktop/src/main/extensions/desktop-extension-registry.ts # + pi-browser 条目
packages/desktop/src/main/pi/desktop-builtin-provider.ts # + pi-browser inline factory
packages/desktop/src/main/ipc.ts                        # browser* handler + 广播（state/create-tab）
packages/desktop/src/main/index.ts                      # BrowserManager/server 装配 + webviewTag + env 注入
packages/desktop/src/main/sidecar/thread-worker-registry.ts # PI_BROWSER_HOST_PORT/TOKEN env 放行
packages/desktop/src/preload/index.ts                   # desktopApi.browser 实现
packages/desktop/src/renderer/src/components/panel/browser/  # 面板 + pending 缓冲 + 请求监听
packages/desktop/src/renderer/src/components/chat/tools/browser-content.tsx # 工具卡片
packages/desktop/src/renderer/src/components/chat/tool-view.tsx / tool-content.tsx # browser 分支
packages/desktop/src/renderer/src/app/routes/settings.browser.tsx # 浏览器设置页路由（§17）
packages/desktop/src/renderer/src/features/settings/browser/ # 设置页三件套（§17）
packages/desktop/src/renderer/src/webview.d.ts          # webview 标签最小类型
packages/desktop/src/renderer/src/styles/browser-panel.css
packages/desktop/test/browser-*.test.ts（8 个）+ pi-browser-extension.test.ts
packages/desktop/test/browser-site-policy.test.ts       # 站点策略测试（§17）
```

P2 预留（尚未创建）：`browser-session-policy.ts`（权限策略细化）、多窗口 BrowserManager 隔离/keep-alive 方案、编号高亮 overlay。标注的 guest preload 与独立 messages.enqueue 方案已按产品决策改为 renderer overlay + composer quote。

## 16. 交接记录（Handoff，2026-08-06）

本节记录 P0/P1 实现完成后的交接状态：已实现范围、架构决策落点、验证结果、已知残留与下一步。后续会话/开发者以此为准，避免重复调研或破坏既有约定。

### 16.1 状态总览

| 阶段 | 状态 | 验证 |
|---|---|---|
| P0 原型（webview 面板 + BrowserManager + IPC） | 已完成 | 29 测试通过、`npm run check` 全绿 |
| P1 工具化（pi-browser + CDP 元素交互 + snapshot 编号） | 已完成 | 72 个 browser 测试通过、tsc 三配置 0 错误 |
| P2 打磨（标注、设置页、多窗口语义等） | 未开始 | 见 16.6 |

**未提交**：截至本节写入时，全部实现仍在工作区（未 commit）。工作区内另有并行会话的改动（`message-part-grouping.ts`/`assistant-message-content.tsx`/`run-activity-group.tsx` 及其测试、`AGENTS.md` 顶部通用准则），与本功能无关，提交时不得包含。`test/renderer-boundaries.test.ts` 中 `auto-title-settings.css` fixture 行也来自并行会话，与本功能混在同一文件（提交前需与并行会话确认归属或接受一并提交）。

### 16.2 已实现内容（与规范章节对照）

- **P0**（§4/5/6/9）：renderer `<webview partition="persist:browser">` 多 tab 面板（地址栏、back/forward/reload/stop、崩溃重建、面板切换时 URL 快照恢复）；main `BrowserManager`（TabRegistry、attach/detach/selectTab/navigate/screenshot、`browserStateChanged` 广播）；`BrowserSettingsService`（§9.3 全字段，仿 auto-title 模式）；权限默认全拒绝（§10，BrowserManager 构造时对分区设置）。
- **P1**（§6/7/8）：CDP 元素交互（`WebContentsHostController`：debugger 按需 attach、命令串行队列 + 10s 超时、`Accessibility.getFullAXTree` 简化 + 可交互编号 + boundingBox center、`Input.dispatchMouseEvent/insertText`、scroll、导航后编号缓存失效）；`openTab`（main → renderer `browserCreateTabRequest` 广播 → renderer 创建 webview → attach 带 requestId resolve，15s 超时）；本地 HTTP RPC server（§16.3）；pi-browser extension 12 个工具（含需批准的 `browser_history`）；工具卡片渲染（§7.3，toolHeader + browser-content.tsx）。

### 16.3 关键架构决策（实现期确定，规范正文未写明的部分）

1. **sidecar → main 通道 = 本地 HTTP RPC**：pi extension 运行在 sidecar 进程（Electron-as-Node），无法直接调用 main 的 BrowserManager，也不能访问 sidecar host 的 `requestHost`（subagents 专用）。实现为 main 起 `http://127.0.0.1:<随机端口>` server（`browser-host-server.ts`），32 字节随机 token 经请求头 `x-desktop-browser-token` 校验；端口与 token 通过 worker env 注入 sidecar：`PI_BROWSER_HOST_PORT` / `PI_BROWSER_TOKEN`。RPC 方法白名单：tabsList/activeTab/navigate/historyTarget/goBack/goForward/reload/snapshot/inspectElement/action/openTab/screenshot/history/clearData/getSettings；1MB body 上限；未知方法 500。
2. **P0 不引入 CDP**：导航/截图/状态全部用 webContents 原生 API（`loadURL`/`capturePage`/生命周期事件），CDP 仅 P1 元素交互、标注拾取与重定位按需 attach（每 host 独立 debugger，无多 tab 冲突）。
3. **renderer 建 tab 请求缓冲**：`browser-pending-requests.ts` 模块级缓冲 + 订阅者通知；面板已挂载时请求直通消费（不入缓冲，避免面板卸载重放），未挂载时入缓冲待挂载消费；requestId 经 `attach(webContentsId, requestId)` 回传 main resolve。
4. **`onOpenPanel` 广播已删除**（死代码）：main 只发 `browserCreateTabRequest`，renderer 收到即开面板（`browser-request-listener.tsx`）。

### 16.4 审查修复记录（P1 reviewer 发现的 should-fix 均已修复）

- 导航/加载后清空可交互编号缓存（防 stale click 点到错误元素）。
- `maxSnapshotNodes`（默认 200）在快照树构建时生效（budget 截断，含 root 自身计数）。
- `performAction` 整体入 CDP 串行队列；未知 action 类型报错（不再静默成功）。
- RPC `action` 参数运行时校验（`parseBrowserAction`），非法形状返回错误。
- `openTab` resolve 时回读 entry.tab（不再返回 about:blank 旧值）。
- renderer 缓冲消费后不再重放（已处理请求不残留）。
- `browser_screenshot` 卡片兼容 `{ dataUrl }` 对象形态。
- submit 确认 fail-closed（`ctx.ui.confirm` 异常时拒绝提交）。
- AX 属性 checked/selected 按类型解析（`asBoolean`，避免 `Boolean("false")===true`）。
- spill 文件名加随机后缀防同毫秒覆盖。
- 新增测试：`browser-ax-snapshot.test.ts`（AX 纯函数）、`browser-pending-requests.test.ts`（缓冲语义）。

### 16.5 已知残留与降级（接手者注意）

- **allowSites/blockSites 未接入**（spec §10.5）：设置字段已持久化但无消费者；站点级确认降级为仅 type submit 确认。接入方式：RPC 白名单加 `getSettings`（或 server 启动时读取设置注入），extension 在 openTab/navigate 前检查 host。
- **`ctx.ui.confirm` 在 desktop 的表现未实测**：submit 确认路径依赖 pi UI 层在桌面端的渲染，需真实环境验证。
- **真实 webview 行为未实测**：attach 时序、CDP 在真实页面上的 AX 树质量、崩溃重建需 `npm run dev` 人工验证（单测用 FakeHost/合成数据）。
- **多窗口/多会话共享全局 BrowserManager 的语义串扰**：`attach` 抢占 activeTabId、广播全窗口；已按"全局单例"语义实现（spec §4.1 注明），多窗口同时使用需产品确认。
- **openTab 超时错误文案**：超时经 HTTP 500 信封返回，模型只能看到 "HTTP 500"；如需友好文案需在 client 层映射。
- **离屏元素未排除**：`isVisible` 只查 boundingBox 尺寸，不查视口内；折叠区外元素可能编号但点击坐标在视口外（P2）。
- **spill 文件无清理**：/tmp 下 `pi-browser-snapshot-*.txt` 需定期清理（P2）。

### 16.6 下一步（P2 候选清单）

1. 设置页 UI（`/settings/browser`，控制器仿 auto-title 三件套）+ `SETTINGS_LINKS` 注册。
2. allow/block 站点接入与站点级确认（16.5）。
3. 标注（Annotation，§11）：`browser-comment-preload.ts` + overlay。
4. 历史/地址栏搜索、清除数据 UI。
5. 多窗口语义确认、keep-alive 面板（§4.1）。
6. 真实环境验证清单：`npm --prefix packages/desktop run dev` 人工验证 webview 面板、`browser_open` 工具端到端（含 type submit 确认）、崩溃重建、CDP 快照质量。
7. 视口内元素过滤、spill 清理、openTab 超时文案。

### 16.7 验证命令速查

```bash
# 全部 browser 相关测试（desktop 包内）
cd packages/desktop && node ../../node_modules/vitest/dist/cli.js --run test/browser-ax-snapshot.test.ts test/browser-pending-requests.test.ts test/browser-manager.test.ts test/browser-host-server.test.ts test/pi-browser-extension.test.ts test/browser-ipc.test.ts test/browser-settings-service.test.ts test/browser-site-policy.test.ts
# 类型检查（main/preload/shared + renderer）
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
# 全仓 check
cd ../.. && npm run check
# 全仓非 e2e 测试（隔离环境）
./test.sh
```

已知：`packages/ai` 有 2 个既有失败（anthropic adaptive thinking 模型元数据、validation null array），上游 models.generated.ts 更新导致，与本功能无关。Windows 上 `packages/coding-agent` 有约 112 个既有失败（EPERM vs EACCES 等平台差异），与本功能无关。

## 17. P2 增补交接（2026-08-07）

本节记录 §16.6 P2 候选清单第一轮完成情况（commit 前的本轮改动）。

### 17.1 本轮完成

- **设置页 UI**（§16.6 #1）：`/settings/browser` 路由 + 三件套（`features/settings/browser/browser-settings-page.tsx` + `use-browser-settings-controller.ts`，仿 auto-title：revision 冲突、dirty 路由守卫、`browserSetEditorDirty` 通道）；`SETTINGS_LINKS` 注册「浏览器」项。页面含：站点访问策略（allow/block 列表，textarea 每行一个 host，经 `parseSiteListInput` 解析）、快照节点数、CDP 超时、下载目录、启动恢复开关、清除浏览数据（ConfirmDialog + `clearData`）。
- **allow/block 站点接入**（§16.5 残留 + §10.5）：`src/shared/browser-site-policy.ts` 纯函数（`siteMatches` host/子域/端口语义、`checkSiteAccess` blocked 优先、`parseSiteListInput` 归一化去重）；RPC 白名单新增 `getSettings`；extension 侧 `SiteAccessController`（`lib/site-access.ts`）：open/navigate 前检查——blockSites 命中直接拒绝、allowSites 命中放行、未列入经 `ctx.ui.confirm` 确认且**会话内按 host 记忆**（同 host 不再询问）；确认通道异常 fail-closed 拒绝；设置读取失败同样 fail-closed。
- **视口内元素过滤**（§16.6 #7）：`buildSnapshotTree` 先评估视口（`Runtime.evaluate`），`collectInteractive`/`buildNode` 增加 viewport 参数，可交互元素要求中心点在视口内（离屏元素不再编号，避免点击坐标不可达）。
- **spill 清理**（§16.6 #7）：`render-snapshot.ts` 新增 `cleanupOldSpills`——写 spill 后异步清理：超过 24h 或超过 100 个时删除最旧文件（best-effort）。
- **openTab 超时文案**（§16.6 #7）：`BrowserClient.request` 对非 2xx 响应解析 body 的 `error` 字段透传（不再只显示 HTTP 500）；模型侧可见「创建浏览器标签页超时」原文。

### 17.2 测试与验证

- 新增 `test/browser-site-policy.test.ts`（纯函数 + SiteAccessController 8 组用例）；`browser-ax-snapshot.test.ts` 加视口过滤用例；`browser-host-server.test.ts` 加 getSettings 白名单用例；`pi-browser-extension.test.ts` 加站点策略/错误透传/spill 清理用例。browser 相关 8 个测试文件共 99 用例全过。
- `npm run check` 全绿（含 renderer boundaries、ts-imports、tsgo）；`tsc` node/web 双配置 0 错误。
- 仓库级 `./test.sh`：desktop 全部通过；`packages/coding-agent` 约 112 个既有失败（Windows 平台差异 EPERM/EACCES 等），与本功能无关。

### 17.3 剩余 P2（未做）

- 标注模式（§11）：`browser-comment-preload.ts` + overlay + `messages.enqueue`。
- 历史/地址栏搜索（`browser_history` 工具需用户批准；当时未做，后续已在 §17.7 完成）。
- 多窗口语义确认、keep-alive 面板（§4.1）。
- `ctx.ui.confirm` 桌面端实机验证、真实 webview/CDP 行为验证（§16.5 残留）。
- 敏感操作确认粒度可配置（当前仅 type submit 与未允许站点确认）。

### 17.4 P2 第二轮增补（2026-08-07）

本轮完成 §17.3 中的标注模式、地址栏历史/搜索、敏感操作确认粒度三项（提交前工作区状态）。

- **标注模式**（§11，宿主侧实现）：
  - 架构偏离 Codex 的 guest preload（comment-preload.js）方案：overlay 由宿主 renderer 绘制（React），**不引入 webview preload**（规避独立构建入口与 guest 注入安全面）；元素拾取经 CDP `Runtime.evaluate` 在页面内执行 `PICK_ELEMENT_SCRIPT`（`elementFromPoint` + 稳定选择器生成：id 优先 → tag+有限 class → 同 tag 兄弟 nth-child → 至多 5 层；`browser-host-controller.ts` 内 `pickElement`/`resolveSelectorBounds` 为宿主接口方法，D1.1 边界保持）。
  - main 侧注释注册表（`BrowserManager.annotationsByTab`，仅内存态）：`addAnnotation/listAnnotations/removeAnnotation/resolveAnnotationBounds`（导航后按选择器重定位）；tab 关闭自动清理。
  - 面板 UI：工具条「标注」toggle → 点击 overlay 拾取（坐标=viewport CSS px）→ 悬浮编辑框（元素 tag/name + textarea，Ctrl/Cmd+Enter 保存）→ 徽标（编号 + hover 文本 + 删除）；导航后批量重定位 bounds；保存后直接追加到当前 thread 的 composer quote（携带元素名称、稳定选择器、页面 URL），composer 未挂载时由 session 定向桥接队列暂存；不再提供独立「提交给 Agent」按钮。
- **地址栏历史/搜索**：main 内存历史（`BrowserManager.history`，上限 200 条，同 URL 合并并提前，`title-updated` 异步回填标题；仅用户 UI，Agent 不可见）；`browserHistory` IPC；面板地址栏 focus 下拉（空输入显示最近 10 条，输入过滤 url/title 包含匹配），点击导航。
- **敏感操作确认粒度**：`BrowserSettings.confirmSensitiveActions: "all" | "unlisted-sites"`（默认 all）；`unlisted-sites` 时允许列表内站点提交免确认（设置读取失败保守确认）；设置页 Combobox 控件。
- 测试：browser 相关 10 文件 121 用例全过（历史合并/清理、标注全链路、IPC 透传、提交粒度 3 用例）；`npm run check` 全绿；`./test.sh` 中 desktop 全过，coding-agent 约 29 个既有 Windows 环境失败（rg 正则差异、EPERM、fswatch、tty）与本功能无关。

### 17.7 P2 第三轮增补（2026-08-07）

本轮针对安全审查与真实 Electron/CDP 联调完成以下闭环：

- **Agent 共享视图与动作安全**：Agent 对指定 tab 的 snapshot/screenshot/action/history 操作开始前自动切换活跃 tab；click/type 携带 snapshot 的页面 URL、role/tag/name/selector/attrs 指纹，CDP 执行前重新解析 backend DOM 节点并校验 live 指纹，DOM 替换或页面变化时 fail-closed 返回 stale ref；滚动携带页面 URL校验。
- **导航与生命周期**：Agent `will-navigate` 与 `will-redirect` 共用同步站点守卫；历史 back/forward 先取得目标 URL并完成站点审批，主进程再次校验目标；`window.open`/`target=_blank` 在 guest 侧统一拒绝并转现有建 tab 请求；openTab 超时后保留 request tombstone，迟到 attach 拒绝且 renderer detach guest，避免孤儿 about:blank tab。
- **CDP 队列**：标注拾取/重定位纳入同一 tab 串行 CDP 队列；AX 快照内 bounds/DOM 描述改为串行命令，避免 `Promise.all` 绕过命令队列。
- **浏览历史工具**：新增 `browser_history`、RPC `history`，每次调用先经 `ctx.ui.confirm`，用户拒绝或服务异常均不读取/不返回历史。
- **真实联调**：使用 `ELECTRON_REMOTE_DEBUGGING_PORT=9222` 启动开发实例并通过 CDP 验证真实 webview attach、`persist:browser` 本地 HTTP 导航、AX 快照编号与 selector、非空 PNG 截图、真实元素标注拾取/保存，以及 CDP 点击后的地址栏/tab 状态同步。
- **回归验证**：browser 相关测试扩展至 10 个文件 141 个用例；node/web/sidecar 三套桌面 TypeScript 检查通过。剩余人工验证为 desktop `ctx.ui.confirm` 的视觉交互和崩溃重建，多窗口/keep-alive 仍需产品确认。

### 17.5 剩余 P2（第二轮后）

- 多窗口语义确认、keep-alive 面板（§4.1，需产品确认）。
- `ctx.ui.confirm` 在 desktop 真实 UI 中的显示与拒绝路径、webview 崩溃重建的人工验证。
- 统一操作结果等待导航完成（当前 CDP 点击后 URL 状态最终同步，工具即时返回可能仍是旧 URL）的体验优化。

### 17.6 加载失败可见性修复（2026-08-07，实机反馈）

实机反馈：地址栏输入 `www.baidu.com` 回车无反应、失焦后输入消失——导航失败（网络层）但错误完全不可见（`did-fail-load` 未被监听）。修复：

- `browser-host-controller.ts`：监听 `did-fail-load`（仅主 frame、忽略 ERR_ABORTED(-3)）→ `BrowserHostEvent "load-failed"`（url/code/description）。
- `browser-manager.ts`：`BrowserTab.loadError` 字段（加载失败时设置，导航成功/开始新加载时清除）；错误码映射中文文案（DNS/拒连/超时/证书/代理等）；`navigate` 增加 30s 挂起超时（`withTimeout`）。
- 面板：地址栏下方常驻显示 `loadError`（提示点击重试）；`submitAddress` 补 IPC 异常 catch 与无 tab 提示；**失焦时若加载失败保留用户输入**（便于修改重试），成功则同步当前 URL。
- 测试：`load-failed` 广播/清除用例。
