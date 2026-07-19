# Renderer CSS 系统规范

## 1. 目标

本规范定义 `packages/desktop/src/renderer` 的样式真相源、级联顺序、组件样式边界和验收方式。目标是：

- 主题值只有一个定义位置，React 只选择主题，不复制颜色；
- Tailwind utility、基础控件和工作台结构样式具有可预测的覆盖关系；
- 组件拆分后，父组件不再依赖子组件内部 DOM；
- 高频交互通过 CSS 变量和单节点更新完成，不因样式变化重渲染整棵子树；
- 键盘、减少动态效果和系统高对比度模式拥有统一基础契约。

## 2. 入口与文件职责

Renderer 仍由 `src/main.tsx` 导入根 `styles.css`。根文件是兼容入口，只允许包含：

```css
@import "./styles/index.css";
```

实际入口为 `src/styles/index.css`。该文件只负责：

1. 声明 cascade layer 顺序；
2. 导入 Tailwind、第三方 CSS 和本地样式；
3. 声明 Tailwind 扫描源。

基础文件职责如下：

| 文件 | 职责 | 禁止内容 |
| --- | --- | --- |
| `tokens.css` | 主题、颜色、字体、空间、控件尺寸、圆角、阴影、动态效果、层级和布局 token | 具体组件选择器 |
| `base.css` | 根节点、reset、焦点、滚动条、减少动态效果、强制颜色模式 | 业务组件布局 |
| `utilities.css` | 少量跨组件且语义稳定的工具契约 | 页面和功能块样式 |
| `components.css` | App 级通知、阻断层等尚未组件化的公共表面 | 新增页面布局 |
| `layout.css` | 主框架、侧栏、标题栏和设置页的领域样式 | Chat、Panel 内部样式 |
| `chat.css` | Chat、Composer、Tool 和 Notice 的领域样式 | App Shell 与设置页样式 |
| `panel.css` | Workbench、File、Task、Terminal 的领域样式 | Chat 与设置页样式 |
| `markdown.css` | Streamdown 根契约 | 通用排版 reset |
| `overrides.css` | 已审计的第三方 DOM 或 inline-style 兼容覆盖 | 普通组件样式 |

`layout.css`、`chat.css`、`panel.css` 是当前领域样式所有者，不与“一组件一文件”的 TypeScript 门禁绑定。组件内部样式出现复用冲突或选择器外泄时，可以按领域逐步迁入同目录 CSS Module；本阶段不把全量 CSS Module 迁移声明为已完成约束。

## 3. Cascade Layer

固定顺序为：

```css
@layer theme, base, components, utilities, overrides;
```

- `theme`：只产生 token；
- `base`：元素默认值和无障碍基础契约；
- `components`：第三方样式、基础控件和组件局部结构；
- `utilities`：Tailwind utility 与明确的公共工具类，可覆盖组件默认值；
- `overrides`：最后手段，仅处理无法直接传入 className 的第三方 DOM 或当前 inline style 兼容。

新增 `!important` 前必须满足以下条件之一：

1. 覆盖第三方 inline style；
2. `prefers-reduced-motion` 必须终止已有 animation 或 transition；
3. `forced-colors` 必须恢复被组件 utility 取消的系统焦点 outline；
4. 已记录移除条件和后续所有者。

当前 `overrides.css` 只保留 Radix ScrollArea viewport 包装节点尺寸例外。Workbench 已使用 CSS 变量驱动尺寸，响应式 overlay 由 `panel.css` 正常拥有。

## 4. 主题真相源

主题选择器统一为：

```css
html[data-theme="light"]
html[data-theme="dark"]
```

`:root:not([data-theme])` 只提供脚本执行前的浅色回退，不是第三套主题。

Tailwind `dark:` 变体必须与同一属性对齐：

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

React 主题层只负责：

- 解析 `system | light | dark` 偏好；
- 把最终值写入 `data-theme`；
- 监听系统主题变化并持久化偏好。

React、组件 CSS 和第三方适配代码不得重新声明 light/dark 颜色或字体常量。xterm 已通过 `readCssColorToken` / `readCssToken` 从 computed style 读取 `--terminal-*` 与 `--font-family-mono`。

## 5. Token 分类

### 5.1 颜色

兼容 shadcn 与现有 Tailwind 类的 token 继续使用 `--background`、`--foreground`、`--muted` 等名称。新增状态使用语义名称：

- `--destructive`：错误和破坏性操作；
- `--success`：成功和新增 diff；
- `--warning`：需要注意但可继续的状态；
- `--info`：中性信息提示；
- `--terminal-*`：xterm 和终端容器共享的主题表面。

颜色组件通过 `@theme inline` 映射为 Tailwind `bg-*`、`text-*`、`border-*` 工具类。组件不得直接新增十六进制颜色；操作系统窗口按钮等平台规范色需要在 token 中单独命名。

### 5.2 字体和密度

- `--font-family-sans`：工作台 UI；
- `--font-family-mono`：终端、代码、路径和命令；
- `--type-size-caption` 至 `--type-size-title`：以 `rem` 表达的既有密度刻度；
- `--control-size-xs` 至 `--control-size-lg`：以 `rem` 表达的控件高度。

根字号使用浏览器基准的 `100%`。后续 UI 字号偏好只调整根字号，字体、控件和布局 token 随之缩放；组件不得用固定 `px` 锁定字号或控件尺寸。最小字号约束通过 `--type-size-*` token 表达，caption 仅用于非交互辅助文本。

### 5.3 空间、形状和阴影

- `--space-1` 至 `--space-9` 是以 `rem` 表达的有限空间刻度；
- `--shape-radius-*` 表达组件形状，组件内不继续散布固定像素圆角；
- `--elevation-popover`、`--elevation-workbench`、`--elevation-composer*` 表达表面关系，不按页面复制阴影值。

### 5.4 动态效果与层级

- 动态效果使用 `--motion-duration-*` 和 `--motion-ease-*`；持续旋转使用独立的 `spinner` 时长与线性 easing；
- z-index 使用 `--stack-*`，禁止新增裸数字；
- `prefers-reduced-motion: reduce` 下，非必要动画、平滑滚动和过渡必须近似即时完成；
- `forced-colors: active` 下，可见焦点必须使用系统 `Highlight`。

### 5.5 布局

侧栏、标题栏、Topbar、Workbench 和 Terminal 的稳定尺寸统一使用 `--layout-*`。CSS media query 目前不能可靠使用自定义属性作为断点，因此断点使用与默认视觉宽度等值的 `rem` 字面值，并在根字号变化时同步缩放。

可缩放 Panel 内部适配应使用 container query，不应继续按 BrowserWindow 宽度推断组件可用宽度。

## 6. 组件样式边界

需要进一步隔离的复杂组件可以采用以下结构：

```text
components/panel/workbench-panel/
  workbench-panel.tsx
  workbench-panel.module.css
```

当前可执行规则如下：

1. 一个 `.tsx` 文件只定义一个 React 组件；
2. 领域聚合 CSS 只能选择本领域拥有的 root、状态属性和明确 `data-slot` 契约；
3. 父组件只控制子组件在父布局中的位置和可用尺寸；
4. 子组件拥有自己的内部 spacing、typography、状态和动画；
5. 状态优先使用 `data-state`、`data-active`、`data-tone`，不新增全局 `.is-active`；
6. CSS Module 一旦引入，只服务同名组件；只有第三方节点无法接收 className 时才使用 `:global`；
7. `data-slot` 是测试和第三方组合契约，不是跨组件堆叠任意样式的入口；
8. 不创建 barrel `index.ts`，调用方直接导入具体组件文件。

基础 Button、Input、Select 等 primitive 可以继续使用 CVA 和 Tailwind utility。复杂布局不应把整块 CSS 继续转写成超长 className 字符串。

## 7. JS 驱动样式

拖拽、窗口尺寸和主题是 JavaScript 与 CSS 的明确边界。

当前公共 helper 包含：

- `useResizableRegion`：pointer capture、边界计算、每帧一次 CSS 变量写入、ARIA 同步和 pointerup 持久化；
- `readCssColorToken`：把 CSS 颜色 token 解析为第三方库可接受的颜色字符串；
- `applyThemePreference`：只更新主题属性，不维护第二份颜色表。

`useResizableRegion` 的中文 JSDoc 必须说明：拖拽期间不得用 React state 驱动整个 Panel 子树重渲染；只允许更新区域根节点的尺寸变量和 separator 的 `aria-valuenow`，结束后再提交持久状态。

## 8. Focus 与交互契约

基础层为原生交互元素、ARIA button/radio/tab/separator 和可聚焦节点提供统一 `focus-visible`。组件可以通过 Tailwind ring 覆盖视觉样式，但不得完全移除键盘焦点反馈。

以下复合交互已完成语义收敛，并作为回归契约：

- Workbench tabs 使用 Radix Tabs；
- 主题选择使用 Radix RadioGroup；
- Composer suggestions 建立 textarea 与 listbox 的 `aria-controls`、`aria-activedescendant`；
- FileTree 建立 tree/treeitem、roving tabindex 和方向键契约；
- 阻断层使用 Radix AlertDialog 管理 focus/inert。

## 9. 已确认但暂不删除的样式

以下 class 在当前 renderer TypeScript/TSX 中没有引用：

- `.app-loading`；
- `.branch-label`；
- `.menu-content`；
- `.menu-item` 及 `.danger` modifier。

本阶段不删除这些规则。删除前应确认其是否属于尚未合并的并发组件工作，并获得功能移除许可。

## 10. 验收

### 10.1 静态检查

- `git diff --check` 无空白错误；
- Desktop web typecheck 通过；
- CSS 入口只有根薄入口和 `styles/index.css`；
- light/dark 色值只在 `tokens.css` 定义；
- 业务 CSS 不处于 unlayered cascade；
- `overrides.css` 中每条规则都有明确移除条件。

### 10.2 Electron CDP

通过开发环境的 CDP 端口验证：

- 视口：1440x920、1181/1180、1101/1100、1024x680；
- DPR：1 和 2；
- 主题：light、dark、system；
- 媒体：reduced motion、forced colors；
- 状态：空工作区、草稿、长标题、长路径、长线程列表、流式 Markdown、工具结果、附件、通知、Host Dialog、Panel 与 Terminal 极限尺寸。

验收必须确认：

1. 无横向溢出、文本遮挡、焦点丢失和不可见操作；
2. Thread Viewport 仍是聊天滚动和自动跟随的唯一所有者；
3. 调整 Panel/Terminal 尺寸时，历史消息 DOM 节点身份保持稳定；
4. reduced motion 下不再平滑滚动或持续旋转；
5. light/dark 切换后，Popover、Dialog、Markdown、Terminal 和原生滚动条使用一致主题；
6. Console 无 CSS parse error、React hydration/DOM nesting error和未处理异常。
