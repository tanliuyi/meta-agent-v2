/**
 * Desktop 内置浏览器（IAB）IPC 契约。
 *
 * 浏览器按会话（ThreadWorkerBinding 的 projectId + sessionId/threadId）隔离：
 * 每个会话使用独立的 `persist:browser-<hash>` Electron partition（profile/
 * cookie/cache 互不共享），BrowserManager 内部按 sessionKey 维护各自的
 * tab/active/history/annotations/pending 状态。所有 IPC、RPC、状态广播与建 tab
 * 请求都携带 `BrowserSessionIdentity`，renderer 与 sidecar 按身份路由。
 */

/** 浏览器会话身份：与 thread sidecar 的 ThreadWorkerBinding 对齐（create 用 sessionId）。 */
export interface BrowserSessionIdentity {
  projectId: string;
  threadId: string;
}

/** 会话键：main/renderer 两侧一致的稳定键（与 renderer sessionRecordKey 同格式）。 */
export function browserSessionKey(identity: BrowserSessionIdentity): string {
  return `${identity.projectId}\u0000${identity.threadId}`;
}

/** 会话专用 Electron partition：确定性 64 位 FNV-1a 十六进制，仅 [a-f0-9]。 */
export function browserPartitionFor(identity: BrowserSessionIdentity): string {
  return `persist:browser-${fnv1a64Hex(`${identity.projectId}\u0000${identity.threadId}`)}`;
}

/** partition 是否属于会话浏览器（webview will-attach 白名单格式校验）。 */
export function isBrowserSessionPartition(partition: string): boolean {
  return /^persist:browser-[0-9a-f]{16}$/.test(partition);
}

/** 64 位 FNV-1a（非加密；仅用于分区命名，不用于安全边界）。 */
function fnv1a64Hex(input: string): string {
  const big = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  let hash = big;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

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

/** 将当前页面 PNG 写入系统剪贴板的结果。 */
export type BrowserClipboardResult = { ok: true } | { ok: false; error: string };

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

/** 页面 console 日志条目（对齐 Codex browser_use 的 tab_dev_logs）。 */
export interface BrowserConsoleEntry {
  level: "log" | "info" | "warning" | "error" | "debug";
  message: string;
  timestamp: number;
  url?: string;
}

/** 挂起的 JS 对话框（alert/confirm/prompt/beforeunload；对齐 Codex tab_get_js_dialog）。 */
export interface BrowserPendingDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultText?: string;
}

/** JS 执行结果（对齐 Codex PlaywrightEvaluate / Runtime.evaluate）。 */
export type BrowserEvaluateResult = { ok: true; value: string; type: string } | { ok: false; error: string };

/** 浏览器会话状态广播（tabs 列表 + 活跃 tab）；renderer 按 sessionKey 路由。 */
export interface BrowserStateEvent {
  sessionKey: string;
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
      /** 先全选清空输入框再输入（替换语义）；缺省为插入（追加）。 */
      replace?: boolean;
      target?: BrowserActionTarget;
    }
  | {
      type: "scroll";
      direction: "up" | "down" | "top" | "bottom";
      amount?: number;
      expectedUrl?: string;
    };

export type BrowserActionResult =
  | { ok: true; url?: string; title?: string; navigationBlocked?: string }
  | { ok: false; error: string; staleRef?: boolean };

/** main 请求 renderer 创建新 tab（工具 browser.open 等触发）；按 sessionKey 路由。 */
export interface BrowserCreateTabRequest {
  requestId: number;
  url: string;
  sessionKey: string;
}

/** main 请求 renderer 关闭指定 tab（工具 browser.close 触发）；renderer 删除视图并 detach。 */
export interface BrowserCloseTabRequest {
  sessionKey: string;
  tabId: number;
}

export type BrowserOpenTabResult = { ok: true; tab: BrowserTab } | { ok: false; error: string };
