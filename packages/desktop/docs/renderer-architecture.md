# Desktop Renderer 架构规范

## 1. 目标

`packages/desktop/src/renderer/src` 是 Electron renderer 的唯一 React 应用。该目录必须满足：

- Pi session、timeline 与持久化状态不在 renderer 建立第二份权威数据；
- 页面组合、业务组件、runtime adapter、应用状态和通用 UI 具有单向依赖；
- 一个 `.tsx` 文件最多定义一个 React 组件；
- 高频状态通过 selector 更新实际消费它的叶子组件，不广播整棵工作台；
- 公共方法按领域放置，不创建无所有权的 `common.ts` 或 `utils.ts`；
- CSS、主题与第三方控件适配只有一个真相源。

## 2. 目录职责

```text
src/
  main.tsx                 renderer 挂载入口，不包含路由或业务状态
  app/                     route、provider 与窗口级静态组合
  features/                独立页面或窗口级功能
    node-runtime/          Node runtime 阻断与安装
    settings/              设置路由和设置内容
  components/
    assistant-ui/          assistant-ui/Radix 的产品适配组件
    chat/                  Thread、Composer、Message、Tool、Host UI
    layout/                Sidebar、Project、Thread 导航、窗口顶栏
    panel/                 Workbench、File、Task、Terminal
  runtime/                 Pi timeline、repository、command 与 assistant-ui adapter
  state/                   Desktop reducer、store、selector、controller 与主题
  shared/
    hooks/                 跨业务且具有稳定交互契约的 hook
    lib/                   无 React、无业务状态的纯方法
    ui/                    通用无业务语义 UI primitive
  styles/                  token、base、cascade layer 与领域样式
```

`app` 只做组合。业务读写不得回流到 `main.tsx` 或 route 声明。设置路由不挂载 `DesktopProvider`，因此进入设置不会 attach Pi session 或初始化 chat runtime。

## 3. 依赖方向

允许方向：

```text
main -> app
app -> features | components | state | shared
features -> components | state | shared
components -> runtime | state | shared | sibling components
state -> runtime | shared
runtime -> shared
shared -> shared
```

禁止：

- `runtime -> state/components/features/app`；
- `state -> components/features/app`；
- `shared -> runtime/state/components/features/app`；
- 本地 `index.ts` / `index.tsx` barrel；
- 为缩短路径而跨层 re-export。

跨层依赖使用 `@renderer/*` 并直接指向具体文件；同目录或同一领域目录内使用相对路径。共享协议继续从 `src/shared` 使用相对路径导入，明确 renderer 与 Electron shared contract 的边界。

## 4. 数据链

消息数据链固定为：

```text
Pi / JSONL
  -> main SessionRuntime / projector
  -> preload typed IPC
  -> PiSessionBus
  -> PiThreadStore
  -> PiMessageRepositoryConverter
  -> assistant-ui External Store Runtime
  -> Thread / Message primitives
```

约束：

1. `PiThreadStore` 是 active timeline 的 renderer external store，不是持久化源。
2. `PiMessageRepositoryConverter` 只投影并复用 identity，不执行命令、不写 timeline。
3. assistant-ui 是 UI facade；optimistic message、queue routing 和 capability 不得进入 Pi timeline。
4. session control 与 workbench 走 Desktop reducer；消息正文不进入该 reducer。
5. renderer 只保留 active `SessionBootstrap`，thread catalog 只保留摘要。
6. attach 必须先 prepare，再由 controller 原子 commit runtime 与 Desktop selection。
7. `PiSessionBus` attachment generation、controller navigation generation 与 runtime switch generation 各自只管理本层竞态，不合并为共享全局序号。
8. `PiMessageRepositoryConverter` 按 Pi part 引用缓存 `ThreadAssistantMessagePart`；delta 不得替换同消息内未变化的 Tool/artifact 引用。

## 5. Desktop Store

`DesktopProvider` 创建一个 Zustand vanilla `StoreApi<DesktopState>`。Reducer 仍是唯一状态转换入口，Zustand 只负责 external-store 订阅。

组件必须使用：

- `useDesktopSelector(selector)`：读取 primitive 或引用稳定的领域对象；
- `useDesktopActions()`：读取稳定命令，不订阅状态。

禁止重新引入返回整对象的 `useDesktop()`。事件回调中需要的状态由 controller 在调用时执行 `store.getState()`，组件不得为了回调订阅 Project、catalog 或 Workbench。

Electron structured clone 会重建数组和对象。`mergeSessionControl()` 必须复用语义未变化的 `models`、`commands`、`thinkingLevels`、`hostRequests`、`statuses` 和 `widgets` 引用，保证 selector 的 `Object.is` 判定有效。

## 6. React 更新边界

目标不是在大组件外包一层 `memo`，而是让订阅与 DOM 所有权一致：

- 窗口标题只更新 title/header 组件；
- error 只更新通知节点；
- active session key 只重建 session-scoped Panel/Terminal；
- Composer text 只更新 textarea、suggestion 和发送可用性；
- control revision 不重新执行历史 `Messages`；
- streaming delta 只替换目标 message/part identity；
- resize 拖动只写 region 根 CSS 变量和 separator ARIA，pointerup 后才提交 Workbench。

Selector 不得返回每次新建的对象或数组。空数组使用模块级稳定常量；组合视图拆成多个叶子组件，不以一个大对象 selector 代替整对象 Context。

## 7. 组件文件

每个 `.tsx` 文件最多一个顶层 React 组件，并禁止在组件函数内部声明组件。允许同文件存在：

- 组件专用 props/type；
- 仅供该组件使用的 primitive 常量；
- 不返回 JSX 的短小局部方法。

复合控件使用同名目录拆分，例如：

```text
model-selector/
  model-selector-root.tsx
  model-selector-trigger.tsx
  model-selector-content.tsx
  model-selector-context.ts
  model-selector-model.ts
```

消费者直接导入实际组件文件。不得用新的聚合文件恢复旧 compound export。

## 8. Common 与 JSDoc

公共代码按最窄所有权放置：

- store selector 放 `state/desktop-selectors.ts`；
- transport identity 放 `runtime`；
- Composer、Tool、Thread 的格式化与解析放对应业务目录的 `.ts`；
- 真正跨业务的无 React 方法放 `shared/lib`；
- 跨业务交互 hook 放 `shared/hooks`。

中文 JSDoc 用于说明：

- 权威来源与不可变条件；
- identity/reference 复用保证；
- attach、generation、reseed、queue clear 等竞态顺序；
- debounce/flush、pointer capture、ARIA 与 CSS 变量写入契约；
- 第三方 API 与 Pi 语义之间的适配差异。

纯展示 JSX、显而易见的 getter 和单行事件转发不添加叙述式注释。

## 9. CSS

CSS 架构见 [Renderer CSS 系统规范](./renderer-css-system.md)。关键边界：

- `styles/tokens.css` 是主题值唯一来源；
- React 只写 `html[data-theme]`；
- Tailwind/CVA 负责基础 primitive，复杂工作台结构由 feature 样式负责；
- 父组件不选择子组件内部 DOM；
- 状态使用 `data-state`、`data-active`、`data-tone`；
- Lucide 运行时导入直接指向 typed per-icon ESM，禁止 `lucide-react` barrel；
- 新样式必须进入明确 cascade layer，不增加无归属的全局规则。

## 10. 验证

静态 gate：

```bash
node scripts/verify-desktop-renderer-boundaries.mjs
npm run typecheck --prefix packages/desktop
git diff --check
npm run check
```

修改测试文件后，必须从 `packages/desktop` 运行对应 Vitest 文件。根 `npm run check` 已接入 renderer boundary gate，代码改动最终必须运行完整命令。

Electron CDP 验收必须覆盖：route/provider 生命周期、Project/thread 导航、draft/session Composer、流式消息、Tool/Host UI、设置、主题、Panel/Terminal resize、键盘与焦点，并通过 DOM identity 与 MutationObserver 证明历史消息没有无关替换。
