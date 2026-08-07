/**
 * Desktop 内置浏览器（IAB）IPC 契约。
 *
 * 浏览器面板在 renderer 持有 `<webview partition="persist:browser">` 标签；
 * guest webContents 实例归属 main 进程。renderer 在 webview attach 后把
 * `webContentsId` 交给 main 注册（BrowserManager），此后导航/截图/状态
 * 全部由 main 驱动并经 `browserStateChanged` 事件广播回 renderer。
 *
 * P0 范围：tab 注册、导航、截图、状态同步。元素级交互（click/type/snapshot）
 * 与 CDP 控制在 P1 通过同一 BrowserManager 扩展，不改变本文件外的 IPC 形状。
 */

/** 内置浏览器 webview 使用的独立 session 分区（renderer 面板与设置页共用）。 */
export const BROWSER_PARTITION = "persist:browser";

/** 内置浏览器中的一个 tab（对应一个已 attach 的 webview）。 */
export interface BrowserTab {
  /** BrowserManager 自增分配，稳定标识；renderer 侧用于与 webview 元素映射。 */
  tabId: number;
  /** 当前 URL（about:blank 等初始页也可能出现）。 */
  url: string;
  /** 页面标题（未定稿时为空串）。 */
  title: string;
  /** 是否处于加载中（did-start-loading / did-stop-loading）。 */
  loading: boolean;
  /** guest 渲染进程崩溃（render-process-gone），需重建 webview。 */
  crashed: boolean;
  /** 最近一次加载失败的网络错误（did-fail-load；DNS/连接/证书等），无则缺省。 */
  loadError?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  createdAt: number;
}

/** renderer 报告 webview attach 的结果。 */
export type BrowserAttachResult = { ok: true; tab: BrowserTab } | { ok: false; error: string };

/** 导航结果；失败（非法 URL、加载失败）返回结构化错误而非 throw。 */
export type BrowserNavigateResult = { ok: true; tab: BrowserTab } | { ok: false; error: string; staleRef?: boolean };

/** 截图结果；dataUrl 为 PNG base64。 */
export type BrowserScreenshotResult =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; error: string };

/** 访问历史（最近在前，上限 200 条；仅用户 UI，Agent 侧不可见）。 */
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  timestamp: number;
}

/** 视口内矩形（CSS px）。 */
export interface BrowserAnnotationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一条页面标注（§11 标注模式；绑定元素选择器而非一次性坐标）。 */
export interface BrowserAnnotation {
  id: string;
  tabId: number;
  /** 元素 CSS 选择器（导航后用于重定位）。 */
  selector: string;
  /** 底层元素标签（展示用）。 */
  tag: string;
  /** 创建时的视口 bounds（overlay 绘制用；导航后经 resolve 刷新）。 */
  bounds: BrowserAnnotationBounds;
  /** 标注文本（视为不可信输入）。 */
  text: string;
  createdAt: number;
}

export interface BrowserAnnotationInput {
  selector: string;
  tag: string;
  bounds: BrowserAnnotationBounds;
  text: string;
}

/** 标注选取结果：pickAnnotationTarget 的返回。 */
export type BrowserAnnotationPickResult =
  | { ok: true; selector: string; bounds: BrowserAnnotationBounds; tag: string; name: string }
  | { ok: false; error: string };

/** 浏览器全局状态广播（tabs 列表 + 活跃 tab），合并节流后推送。 */
export interface BrowserStateEvent {
  tabs: BrowserTab[];
  activeTabId: number | null;
}

/** 快照树中的一个节点（由 CDP Accessibility.getFullAXTree 简化而来）。 */
export interface BrowserSnapshotNode {
  /** 可交互元素全局编号（从 1 开始，仅可交互元素有）；文本模型凭此定位。 */
  index?: number;
  /** AX role：button/link/textbox/combobox/checkbox/navigation/main/heading/... */
  role: string;
  /** accessible name（截断 ≤ 120 字符）。 */
  name: string;
  /** 输入类元素当前值（截断）。 */
  value?: string;
  /** 底层标签：a/button/input/textarea/select/... */
  tag: string;
  /** 稳定 CSS 选择器（交互元素；模型可对照标注引用定位）。 */
  selector?: string;
  /** 关键属性（供模型判断行为）。 */
  attrs?: {
    href?: string;
    type?: string;
    checked?: boolean;
    selected?: boolean;
    formAction?: string;
    formMethod?: string;
    name?: string;
  };
  /** 视口内元素中心点（CSS px），click/type 定位用。 */
  center?: { x: number; y: number };
  children?: BrowserSnapshotNode[];
}

/** 页面结构化快照（spec §8）。 */
export interface BrowserSnapshot {
  url: string;
  title: string;
  timestamp: number;
  viewport: { width: number; height: number; dpr: number };
  tree: BrowserSnapshotNode[];
  /** data:image/png;base64，仅 withScreenshot=true 时非 null。 */
  screenshot: string | null;
}

export type BrowserSnapshotResult = { ok: true; snapshot: BrowserSnapshot } | { ok: false; error: string };

export type BrowserInspectElementResult =
  | { ok: true; node: BrowserSnapshotNode }
  | { ok: false; error: string; staleRef?: boolean };

/** Agent 动作执行前用于校验页面与 DOM 目标未发生变化的快照指纹。 */
export interface BrowserActionTarget {
  pageUrl: string;
  role: string;
  tag: string;
  name: string;
  selector?: string;
  attrs?: BrowserSnapshotNode["attrs"];
}

/** 宿主当前导航历史的只读快照。 */
export interface BrowserNavigationState {
  activeIndex: number;
  entries: Array<{ url: string; title: string }>;
}

/** Agent 侧历史动作的目标页面。 */
export type BrowserNavigationTargetResult =
  | { ok: true; current: { url: string; title: string }; target: { url: string; title: string } }
  | { ok: false; error: string };

/** 元素级交互动作（先 snapshot 拿编号，再执行）。 */
export type BrowserAction =
  | {
      type: "click";
      elementIndex: number;
      navigationApprovalUrl?: string;
      target?: BrowserActionTarget;
    }
  | {
      type: "type";
      elementIndex: number;
      text: string;
      submit?: boolean;
      target?: BrowserActionTarget;
    }
  | {
      type: "scroll";
      direction: "up" | "down" | "top" | "bottom";
      amount?: number;
      expectedUrl?: string;
    };

export type BrowserActionResult =
  | { ok: true; url?: string; title?: string }
  | { ok: false; error: string; staleRef?: boolean };

/** main 请求 renderer 创建新 tab（工具 browser.open 等触发）。 */
export interface BrowserCreateTabRequest {
  requestId: number;
  url: string;
}

export type BrowserOpenTabResult = { ok: true; tab: BrowserTab } | { ok: false; error: string };
