import { useNavigate } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import HistoryIcon from "lucide-react/dist/esm/icons/history.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import MoreVertical from "lucide-react/dist/esm/icons/more-vertical.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type BrowserAnnotation,
  type BrowserAnnotationBounds,
  type BrowserAnnotationPickResult,
  type BrowserHistoryEntry,
  type BrowserTab,
  browserSessionKey,
} from "../../../../../shared/browser-contracts.ts";
import type { BrowserPasswordOffer } from "../../../../../shared/browser-data-contracts.ts";
import {
  type BrowserInternalPageId,
  parseBrowserInternalPage,
} from "../../../../../shared/browser-internal-contracts.ts";
import { appendComposerQuote } from "../../../runtime/composer-quotes.ts";
import type { SessionBrowserUiSnapshot } from "../../../runtime/pi-session-store.ts";
import { DropdownMenu } from "../../../shared/ui/dropdown-menu.tsx";
import { DropdownMenuContent } from "../../../shared/ui/dropdown-menu-content.tsx";
import { DropdownMenuItem } from "../../../shared/ui/dropdown-menu-item.tsx";
import { DropdownMenuSeparator } from "../../../shared/ui/dropdown-menu-separator.tsx";
import { DropdownMenuSub } from "../../../shared/ui/dropdown-menu-sub.tsx";
import { DropdownMenuSubContent } from "../../../shared/ui/dropdown-menu-sub-content.tsx";
import { DropdownMenuSubTrigger } from "../../../shared/ui/dropdown-menu-sub-trigger.tsx";
import { DropdownMenuTrigger } from "../../../shared/ui/dropdown-menu-trigger.tsx";
import { useToast } from "../../../shared/ui/use-toast.ts";
import {
  acknowledgeBrowserAnnotationRemoval,
  BROWSER_ANNOTATION_QUOTE_PREFIX,
  browserAnnotationMessageId,
  emitBrowserAnnotationToComposer,
  failBrowserAnnotationRemoval,
  invalidateBrowserAnnotationQuotes,
  removeBrowserAnnotationFromComposer,
  subscribeBrowserAnnotationConsumed,
  updateBrowserAnnotationInComposer,
} from "../../../state/browser-composer-bridge.ts";
import { workbenchPanelTabKey, workbenchTabKey } from "../../../state/workbench-tab-context.tsx";
import type { BrowserWebviewElement, BrowserWebviewFoundInPageEvent } from "../../../webview.d.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope, useSessionWorkbenchTabs } from "../../session-context.tsx";
import { BROWSER_PANEL_KIND } from "../builtin-panel-kinds.ts";
import { BrowserAnnotationMarker } from "./browser-annotation-marker.tsx";
import { AnnotationModeToggle } from "./browser-annotation-mode-toggle.tsx";
import { BrowserNetworkErrorPage, failedAddressDisplay } from "./browser-network-error-page.tsx";
import type { SessionBrowserRuntime } from "./browser-runtime-host.ts";
import {
  activeViewIdOf,
  activeWebviewOf,
  clearRuntimeError,
  closeView,
  createBlankView,
  createView,
  displayUrlOf,
  ensureBrowserRuntime,
  openInternalPageView,
  rebuildView,
  remountView,
  replaceView,
  subscribeBrowserRuntime,
  tabIdOfView,
  webviewOf,
} from "./browser-runtime-host.ts";
import { browserSessionSnapshot, normalizeBrowserSessionSnapshot } from "./browser-session-snapshot.ts";

/**
 * 内置浏览器（IAB）面板。
 *
 * webview 元素由常驻 runtime host（browser-runtime-host）持有：本组件只渲染
 * 工具栏/tab 栏/标注等 UI，并把活跃 tab 的 webview 元素临时移入视口显示
 * （useLayoutEffect 卸载清理时移回 parking host，guest 不销毁、不 detach）。
 * main 的状态广播按 sessionKey 路由到本会话的 runtime，tab 列表与活跃 tab 以
 * 广播为唯一状态源；本组件不维护第二套全局浏览器状态。
 */

interface AnnotationTarget extends Extract<BrowserAnnotationPickResult, { ok: true }> {
  pos: { x: number; y: number };
  tabId: number;
  generation: number;
}

type BrowserDevicePresetId = (typeof BROWSER_DEVICE_PRESETS)[number]["id"];

interface BrowserFindResult {
  activeMatchOrdinal: number;
  matches: number;
}

const BROWSER_DEVICE_PRESETS = [
  { id: "responsive", label: "响应式", width: 951, height: 1023 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
  { id: "laptop-l", label: "Laptop L", width: 1440, height: 900 },
  { id: "laptop", label: "笔记本电脑", width: 1366, height: 768 },
  { id: "surface-pro-7", label: "Surface Pro 7", width: 912, height: 1368 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "surface-duo", label: "Surface Duo", width: 540, height: 720 },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "galaxy-s24-ultra", label: "Samsung Galaxy S24 Ultra", width: 384, height: 854 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
] as const;

/** 面板卸载时保存的 tab URL 快照（按会话）；重新挂载时恢复（应用重启后 main 无浏览器状态）。 */
function sessionStorageKey(sessionKey: string): string {
  return `meta-agent.browser.session.v3.${sessionKey}`;
}

/** 地址栏输入规范化：空忽略；带协议原样；否则补 https://。 */
function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 浏览器面板（按会话隔离；在 workbench panel 内挂载）。 */
export function BrowserPanel() {
  const navigate = useNavigate();
  const { record, updateWorkbench } = useSessionScope();
  const workbenchTabs = useSessionWorkbenchTabs();
  const { notify } = useToast();
  const { projectId: sessionProjectId, threadId: sessionThreadId } = record.identity;
  const sessionKey = browserSessionKey(record.identity);
  const [runtime, setRuntime] = useState<SessionBrowserRuntime>(() => ensureBrowserRuntime(record.identity));
  const [runtimeVersion, setRuntimeVersion] = useState(runtime.version);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [historyEntries, setHistoryEntries] = useState<BrowserHistoryEntry[]>([]);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult>({ activeMatchOrdinal: 0, matches: 0 });
  const [pageZoom, setPageZoom] = useState(1);
  const [deviceToolbarOpen, setDeviceToolbarOpen] = useState(false);
  const [devicePreset, setDevicePreset] = useState<BrowserDevicePresetId>("responsive");
  const [deviceWidth, setDeviceWidth] = useState(951);
  const [deviceHeight, setDeviceHeight] = useState(1023);
  const [deviceZoomPercent, setDeviceZoomPercent] = useState(100);
  const [browserNotice, setBrowserNotice] = useState("");
  // 密码保存请求（main 定向发送；renderer payload 不含密码正文）。
  const [passwordOffer, setPasswordOffer] = useState<BrowserPasswordOffer | null>(null);
  // 标注模式（§11）：开关、当前 tab 标注、正在编辑的目标与编辑框位置。
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);
  const [editingTarget, setEditingTarget] = useState<AnnotationTarget | null>(null);
  // 已保存标注的原位编辑目标（点击 marker 打开；保持原 id，不重建）。
  const [editingAnnotation, setEditingAnnotation] = useState<BrowserAnnotation | null>(null);
  const [hoverTarget, setHoverTarget] = useState<AnnotationTarget | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [pickError, setPickError] = useState("");
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [panelError, setPanelError] = useState("");
  const viewportEl = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const views = runtime.views;
  const tabs = runtime.tabs;
  const activeTabId = runtime.activeTabId;
  const identity = runtime.identity;
  const activeViewId = activeViewIdOf(runtime);
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;
  const activeView = views.find((view) => view.viewId === activeViewId);
  // 显示 URL：attach/navigate 过渡期 tab.url 为 about:blank 时回退到视图目标 URL。
  const activeUrl = displayUrlOf(activeTab?.url ?? "", activeView?.pendingUrl ?? "");
  const sessionSnapshotRef = useRef<SessionBrowserUiSnapshot>(
    record.stores.browserUi.getSnapshot() ?? { urls: [], activeIndex: 0 },
  );
  const sessionSnapshotReadyRef = useRef(runtime.views.length > 0 || runtime.tabs.length > 0);
  const currentSessionSnapshot = (): SessionBrowserUiSnapshot => {
    const currentUrlByTabId = new Map(runtime.tabs.map((tab) => [tab.tabId, tab.url]));
    return browserSessionSnapshot(
      runtime.views.map((view) => {
        const tabId = tabIdOfView(runtime, view.viewId);
        const tabUrl = (tabId === undefined ? "" : currentUrlByTabId.get(tabId)) ?? "";
        return { url: displayUrlOf(tabUrl, view.pendingUrl), active: tabId === runtime.activeTabId };
      }),
      sessionSnapshotRef.current.activeIndex,
    );
  };
  if (sessionSnapshotReadyRef.current) sessionSnapshotRef.current = currentSessionSnapshot();
  const pendingActiveIndexRef = useRef<number | null>(null);
  const annotationGeneration = useRef(0);
  // 标注模式会话代号：进入/退出时递增，使退出前发出的异步 hover/拾取结果失效（不回写）。
  const annotationModeGeneration = useRef(0);
  // 标注模式 hover 拾取节流（120ms + 8px 移动阈值，避免每帧 CDP）；退出时重置。
  const lastHoverQuery = useRef({ x: -1000, y: -1000, time: 0 });
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const showBrowserNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setBrowserNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setBrowserNotice("");
    }, 3_500);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // runtime 订阅：版本变化即重渲染；StrictMode 双挂载幂等。
  useEffect(() => {
    const unsubscribe = subscribeBrowserRuntime(sessionKey, () => {
      setRuntimeVersion((version) => version + 1);
    });
    return unsubscribe;
  }, [sessionKey]);

  const openFindBar = useCallback(() => {
    setMoreMenuOpen(false);
    setFindOpen(true);
  }, []);

  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindResult({ activeMatchOrdinal: 0, matches: 0 });
  }, []);

  // 首次挂载（该会话尚无视图）按持久设置恢复 URL；工具建 tab 请求已由 runtime
  // host 处理（模块级缓冲，不随面板生命周期丢失）。
  useEffect(() => {
    let cancelled = false;
    void window.desktop.browser
      .getSettings()
      .then((snapshot) => {
        if (cancelled) return;
        if (runtime.views.length > 0 || runtime.tabs.length > 0) {
          sessionSnapshotReadyRef.current = true;
          sessionSnapshotRef.current = currentSessionSnapshot();
          return;
        }
        const restored = snapshot.settings.restoreTabsOnLaunch
          ? readStoredSessionSnapshot(sessionKey, record.stores.browserUi.getSnapshot())
          : { urls: [], activeIndex: 0 };
        sessionSnapshotRef.current = restored;
        sessionSnapshotReadyRef.current = true;
        pendingActiveIndexRef.current = restored.activeIndex;
        if (restored.urls.length === 0) {
          createBlankView(runtime);
          return;
        }
        for (const url of restored.urls) createView(runtime, url);
        if (runtime.views.length === 0) createBlankView(runtime);
      })
      .catch(() => {
        if (cancelled) return;
        sessionSnapshotReadyRef.current = true;
        if (runtime.views.length === 0) {
          sessionSnapshotRef.current = { urls: [], activeIndex: 0 };
          createBlankView(runtime);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // runtime 重建时，等目标 view attach 获得 tabId 后恢复之前的活跃索引。
  useEffect(() => {
    const index = pendingActiveIndexRef.current;
    if (index === null) return;
    const view = runtime.views[index];
    if (!view) return;
    const tabId = tabIdOfView(runtime, view.viewId);
    if (tabId === undefined) return;
    pendingActiveIndexRef.current = null;
    if (tabId !== activeTabId) void window.desktop.browser.selectTab(identity, tabId);
  }, [activeTabId, identity, runtime, runtimeVersion]);

  // 把会话 runtime 容器 CSS 定位到面板视口矩形（webview 元素不移动，guest 不销毁）。
  function positionContainerToViewport(container: HTMLElement, viewport: HTMLElement): void {
    container.removeAttribute("data-offscreen");
    const rect = viewport.getBoundingClientRect();
    container.style.position = "fixed";
    container.style.left = `${rect.left}px`;
    container.style.top = `${rect.top}px`;
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;
    // parking host 默认 pointer-events: none；显示时必须恢复交互（隐藏的
    // data-hidden webview 由 display:none 天然不接收事件）。
    container.style.pointerEvents = "auto";
  }
  // 活跃 webview 显示（根因方案）：webview 元素与容器永不移动。
  // Electron 中 webview 元素（或含它的容器）一旦从 DOM 移除，guest 即销毁并重建，
  // 这是面板闪烁、tab 重建、活跃 tab 回退切换的全部根源。因此：
  //   1. 显示面板 = 把会话 runtime 容器 CSS 定位（fixed）到视口矩形，不改 DOM；
  //   2. 关闭面板 = 容器移出屏幕（保留渲染，guest 存活、截图正常）；
  //   3. 切换 tab = 仅切换 data-hidden（display:none 不销毁 guest）。
  // 全程零 DOM 移动 → guest 永不销毁 → 无重建、无闪烁、无活跃回退。
  // 视口位置随窗口尺寸/面板宽度变化由下方 ResizeObserver 同步，开销为单元素
  // 布局读写（应用整体不滚动，无需 scroll 同步）。
  useEffect(() => {
    const viewport = viewportEl.current;
    if (!viewport) return;
    if (activeViewId === undefined) return;
    const element = webviewOf(runtime, activeViewId);
    if (!element) return;
    positionContainerToViewport(runtime.container, viewport);
    // 外部原因（崩溃等）导致 guest 销毁重建期间跳过可见性切换，避免活跃回退闪烁。
    const activeRecord = runtime.views.find((view) => view.viewId === activeViewId);
    if (activeRecord?.rebuilding) return;
    if (activeTab?.loadError) {
      // 网络错误页活跃时隐藏 webview；常驻 fixed 容器不属于 viewport DOM 子树，
      // 不能依赖错误页自身的 z-index 覆盖 guest。
      for (const view of runtime.views) {
        const viewElement = webviewOf(runtime, view.viewId);
        if (viewElement && !viewElement.hasAttribute("data-hidden")) {
          viewElement.setAttribute("data-hidden", "");
        }
      }
      return;
    }
    for (const view of runtime.views) {
      const viewElement = webviewOf(runtime, view.viewId);
      if (!viewElement) continue;
      if (view.viewId === activeViewId) {
        if (viewElement.hasAttribute("data-hidden")) viewElement.removeAttribute("data-hidden");
      } else if (!viewElement.hasAttribute("data-hidden")) {
        viewElement.setAttribute("data-hidden", "");
      }
    }
  }, [runtime, activeViewId, activeTab?.loadError]);
  // 视口尺寸/位置变化（窗口 resize、面板宽度拖拽）：同步容器定位。
  useEffect(() => {
    const viewport = viewportEl.current;
    if (!viewport) return;
    if (activeViewId === undefined) return;
    const update = (): void => positionContainerToViewport(runtime.container, viewport);
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [runtime, activeViewId]);

  // 面板卸载：容器标记为屏幕外（content-visibility:hidden——保留布局尺寸且语义清晰，
  // 等价于 Chromium 后台化；guest 存活，读 DOM/执行 JS 不受影响，截图经 CDP
  // fromSurface:false 仍可用）。重新打开面板时由显示 effect 恢复定位。
  useEffect(() => {
    return () => {
      runtime.container.setAttribute("data-offscreen", "");
      runtime.container.style.pointerEvents = "none";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 设备工具栏/device 尺寸：直接作用于 webview 元素（webview 是视口直接子元素）。
  useEffect(() => {
    const element = activeWebviewOf(runtime);
    if (!element) return;
    if (deviceToolbarOpen && activeViewId !== undefined) {
      element.style.width = `${deviceWidth}px`;
      element.style.height = `${deviceHeight}px`;
    } else {
      element.style.width = "";
      element.style.height = "";
    }
  }, [activeViewId, deviceHeight, deviceToolbarOpen, deviceWidth, runtime, runtimeVersion]);

  // viewport 容器尺寸（标注编辑框位置钳制用）。
  useEffect(() => {
    const element = viewportEl.current;
    if (!element) return;
    const update = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 面板卸载时保存当前 tab URL 与活跃索引；不 detach 任何 webview。
  useEffect(() => {
    return () => {
      if (!sessionSnapshotReadyRef.current) return;
      const snapshot = sessionSnapshotRef.current;
      record.stores.browserUi.setSnapshot(snapshot);
      try {
        window.localStorage.setItem(sessionStorageKey(sessionKey), JSON.stringify(snapshot));
      } catch {
        // localStorage 不可用时仍保留 cached session record 中的内存会话。
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // 地址栏跟随活跃 tab；用户编辑中不覆盖，失败页按 Chrome 隐藏协议与根路径，
  // 过渡期（tab.url 为 about:blank）显示视图目标 URL。
  useEffect(() => {
    if (addressFocused) return;
    const active = tabs.find((tab) => tab.tabId === activeTabId);
    const current = active?.loadError
      ? failedAddressDisplay(active.loadError.url)
      : displayUrlOf(active?.url ?? "", activeView?.pendingUrl ?? "");
    setAddressDraft(current);
  }, [activeTabId, addressFocused, tabs, views, activeViewId]);

  const activeAnnotationUrl = tabs.find((tab) => tab.tabId === activeTabId)?.url ?? "";

  // 活跃 tab URL 变化时：刷新历史列表、拉取该 tab 标注、重定位标注 bounds。
  useEffect(() => {
    void window.desktop.browser
      .browserHistory(identity)
      .then((entries) => {
        if (activeTabIdRef.current === activeTabId) setHistoryEntries(entries);
      })
      .catch(() => undefined);
    const tabId = activeTabId;
    const generation = annotationGeneration.current + 1;
    annotationGeneration.current = generation;
    // 标注创建时登记的页面 URL 与当前 URL 逐条比较（规范化比较与 main 一致）：
    // 已离开页面的 composer 引用同步失效。面板重挂（无 previousUrl 快照）也能
    // 识别隐藏期间的后台导航；about:blank/空 URL 过渡由 bridge 跳过，等真实 URL。
    if (tabId !== null) invalidateBrowserAnnotationQuotes(record.key, tabId, activeAnnotationUrl);
    setAnnotations([]);
    setEditingTarget(null);
    setEditingAnnotation(null);
    setHoverTarget(null);
    setPickError("");
    if (tabId === null) return;
    const isCurrent = () => annotationGeneration.current === generation && activeTabIdRef.current === tabId;
    let cancelled = false;
    const loadAnnotations = async (): Promise<void> => {
      const list = await window.desktop.browser.annotationList(identity, tabId);
      if (cancelled || !isCurrent()) return;
      setAnnotations(list);
      const resolved = await Promise.all(
        list.map(async (annotation) => {
          const bounds = await window.desktop.browser.annotationResolve(identity, tabId, annotation.id);
          return [annotation.id, bounds] as const;
        }),
      );
      if (cancelled || !isCurrent()) return;
      setAnnotations((current) =>
        current.map((annotation) => {
          const pair = resolved.find(([id]) => id === annotation.id);
          return pair && pair[1] ? { ...annotation, bounds: pair[1] } : annotation;
        }),
      );
    };
    void loadAnnotations().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeAnnotationUrl, identity]);

  useEffect(() => {
    const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
    if (!findOpen || !element) return;
    const onFoundInPage = (event: Event) => {
      const result = (event as BrowserWebviewFoundInPageEvent).result;
      if (!result) return;
      setFindResult({
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    };
    element.addEventListener("found-in-page", onFoundInPage);
    return () => element.removeEventListener("found-in-page", onFoundInPage);
  }, [activeViewId, findOpen, runtime, runtimeVersion]);

  useEffect(() => {
    const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
    if (!findOpen || !element) return;
    if (findQuery.length === 0) {
      element.stopFindInPage("clearSelection");
      setFindResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    element.findInPage(findQuery, { forward: true });
    return () => element.stopFindInPage("clearSelection");
  }, [activeViewId, findOpen, findQuery, runtime, runtimeVersion]);

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  const findNext = useCallback(
    (forward: boolean) => {
      const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
      if (!element || findQuery.length === 0) return;
      element.findInPage(findQuery, { forward, findNext: true });
    },
    [activeViewId, findQuery, runtime, runtimeVersion],
  );

  useEffect(() => {
    const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
    if (!element) return;
    try {
      const factor = element.getZoomFactor();
      if (Number.isFinite(factor)) setPageZoom(Math.min(5, Math.max(0.25, factor)));
    } catch {
      // webview 尚未完成 attach 时无法读取缩放，保留当前 UI 值。
    }
  }, [activeViewId, runtime, runtimeVersion]);

  const setPageZoomFactor = useCallback(
    (factor: number) => {
      const next = Math.round(Math.min(5, Math.max(0.25, factor)) * 100) / 100;
      const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
      if (element) {
        try {
          element.setZoomFactor(next);
        } catch {
          showBrowserNotice("页面缩放暂不可用。");
          return;
        }
      }
      setPageZoom(next);
      setDeviceZoomPercent(Math.round(next * 100));
    },
    [activeViewId, runtime, runtimeVersion, showBrowserNotice],
  );

  const adjustPageZoom = useCallback(
    (delta: number) => {
      const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
      let current = pageZoom;
      try {
        if (element) current = element.getZoomFactor();
      } catch {
        // 使用 renderer 中最近一次已知缩放。
      }
      setPageZoomFactor(current + delta);
    },
    [activeViewId, pageZoom, runtime, runtimeVersion, setPageZoomFactor],
  );

  const openDeviceToolbar = useCallback(() => {
    setMoreMenuOpen(false);
    setDeviceToolbarOpen(true);
    if (viewportSize.width > 0) setDeviceWidth(Math.round(viewportSize.width));
    if (viewportSize.height > 0) setDeviceHeight(Math.round(viewportSize.height));
  }, [viewportSize.height, viewportSize.width]);

  const selectDevicePreset = useCallback((id: BrowserDevicePresetId) => {
    setDevicePreset(id);
    const preset = BROWSER_DEVICE_PRESETS.find((candidate) => candidate.id === id);
    if (!preset || id === "responsive") return;
    setDeviceWidth(preset.width);
    setDeviceHeight(preset.height);
  }, []);

  const updateDeviceWidth = useCallback((value: string) => {
    const width = Number.parseInt(value, 10);
    if (Number.isFinite(width)) {
      setDevicePreset("responsive");
      setDeviceWidth(Math.min(3_840, Math.max(320, width)));
    }
  }, []);

  const updateDeviceHeight = useCallback((value: string) => {
    const height = Number.parseInt(value, 10);
    if (Number.isFinite(height)) {
      setDevicePreset("responsive");
      setDeviceHeight(Math.min(2_160, Math.max(240, height)));
    }
  }, []);

  const rotateDeviceViewport = useCallback(() => {
    setDeviceWidth(deviceHeight);
    setDeviceHeight(deviceWidth);
    setDevicePreset("responsive");
  }, [deviceHeight, deviceWidth]);

  const setDeviceZoom = useCallback(
    (percent: number) => {
      setDeviceZoomPercent(percent);
      setPageZoomFactor(percent / 100);
    },
    [setPageZoomFactor],
  );

  const navigateCurrentTabToUrl = useCallback(
    (url: string) => {
      if (activeTabId === null) return;
      setAddressDraft(url);
      setAddressFocused(false);
      setAddressError("");
      if (
        activeViewId !== undefined &&
        (parseBrowserInternalPage(activeTab?.url) !== null ||
          parseBrowserInternalPage(views.find((view) => view.viewId === activeViewId)?.pendingUrl) !== null)
      ) {
        replaceView(runtime, activeViewId, url);
        return;
      }
      void window.desktop.browser
        .navigate(identity, activeTabId, url)
        .then((result) => {
          if (!result.ok && !result.loadError) setAddressError(result.error);
        })
        .catch((value: unknown) => setAddressError(value instanceof Error ? value.message : String(value)));
    },
    [activeTab?.url, activeTabId, activeViewId, identity, runtime, views],
  );

  const submitAddress = useCallback(() => {
    const internalPage = parseBrowserInternalPage(addressDraft);
    if (internalPage !== null) {
      setAddressFocused(false);
      setAddressError("");
      openInternalPageView(runtime, internalPage);
      return;
    }
    if (activeTabId === null) {
      setAddressError("没有可用的浏览器标签页");
      return;
    }
    const url = normalizeAddress(addressDraft);
    if (!url) {
      setAddressError("请输入有效的网址");
      return;
    }
    navigateCurrentTabToUrl(url);
  }, [activeTabId, addressDraft, navigateCurrentTabToUrl, runtime]);

  const openDownloadsPage = useCallback(() => {
    setMoreMenuOpen(false);
    setFindOpen(false);
    openInternalPageView(runtime, "downloads");
  }, [runtime]);

  const printPage = useCallback(() => {
    setMoreMenuOpen(false);
    const element = activeViewId === undefined ? undefined : webviewOf(runtime, activeViewId);
    if (!element) {
      showBrowserNotice("没有可打印的浏览器页面。");
      return;
    }
    void element.print({ printBackground: true }).catch((error: unknown) => {
      showBrowserNotice(`打印失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeViewId, runtime, runtimeVersion, showBrowserNotice]);

  const capturePageScreenshot = useCallback(() => {
    setMoreMenuOpen(false);
    if (activeTabId === null) {
      notify({ title: "截图失败", message: "没有可截图的浏览器页面。", tone: "error" });
      return;
    }
    void window.desktop.browser
      .copyScreenshot(identity, activeTabId)
      .then((result) => {
        if (!result.ok) {
          notify({ title: "截图失败", message: result.error, tone: "error" });
          return;
        }
        notify({ title: "截图已复制", message: "屏幕截图已复制到剪贴板。", tone: "success" });
      })
      .catch((error: unknown) => {
        notify({
          title: "截图失败",
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      });
  }, [activeTabId, identity, notify]);

  const clearBrowserData = useCallback(() => {
    setMoreMenuOpen(false);
    void window.desktop.browser
      .clearData(identity)
      .then(() => showBrowserNotice("浏览器 Cookie、缓存与登录态已清除。"))
      .catch((error: unknown) => {
        showBrowserNotice(`清除浏览数据失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, [identity, showBrowserNotice]);

  const clearDownloadHistory = useCallback(() => {
    setMoreMenuOpen(false);
    void window.desktop.browser
      .browserDownloadsClear()
      .then((result) => {
        if (!result.ok) showBrowserNotice(result.error);
      })
      .catch((error: unknown) => {
        showBrowserNotice(`删除下载历史失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, [showBrowserNotice]);

  const openBrowserSettings = useCallback(() => {
    setMoreMenuOpen(false);
    void navigate({
      to: "/settings/browser",
      search:
        sessionProjectId && sessionThreadId
          ? { returnProjectId: sessionProjectId, returnThreadId: sessionThreadId }
          : sessionProjectId
            ? { draftProjectId: sessionProjectId }
            : {},
    });
  }, [navigate, sessionProjectId, sessionThreadId]);

  const openInternalPage = useCallback(
    (page: BrowserInternalPageId) => {
      setMoreMenuOpen(false);
      setFindOpen(false);
      openInternalPageView(runtime, page);
    },
    [runtime],
  );

  // 密码保存请求：主进程已定向投递，renderer 再按会话身份防御性过滤。
  useEffect(() => {
    const unsubscribe = window.desktop.browser.onPasswordOffer((offer) => {
      if (browserSessionKey(offer.identity) !== sessionKey) return;
      setPasswordOffer((current) => (current === null ? offer : current));
    });
    return unsubscribe;
  }, [sessionKey]);
  const resolvePasswordOffer = useCallback(
    (save: boolean) => {
      if (!passwordOffer) return;
      const offer = passwordOffer;
      setPasswordOffer(null);
      void window.desktop.browser
        .browserPasswordOfferResolve(identity, offer.id, save)
        .then((result) => {
          if (!result.ok) {
            showBrowserNotice(result.error);
            return;
          }
          if (save) showBrowserNotice("密码已保存到密码管理器。");
        })
        .catch((error: unknown) => {
          showBrowserNotice(`密码保存失败：${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [identity, passwordOffer, showBrowserNotice],
  );

  const showImportNotice = useCallback(() => {
    setMoreMenuOpen(false);
    showBrowserNotice("导入 Cookie 和密码暂不支持。");
  }, [showBrowserNotice]);

  // 系统/输入错误保留现有操作反馈；主框架网络错误改由标签页内容区展示。
  const runtimeError = runtime.attachError ?? null;
  const bottomError = panelError || runtimeError || addressError;

  const retryBottomError = useCallback(() => {
    if (panelError || runtimeError) {
      if (runtimeError) clearRuntimeError(runtime);
      const viewId = activeViewId ?? views[0]?.viewId;
      if (viewId !== undefined) remountView(runtime, viewId);
      return;
    }
    if (activeTabId === null) return;
    const url = normalizeAddress(addressDraft);
    if (!url) return;
    setAddressError("");
    void window.desktop.browser
      .navigate(identity, activeTabId, url)
      .then((result) => {
        if (!result.ok && !result.loadError) setAddressError(result.error);
      })
      .catch((value: unknown) => setAddressError(value instanceof Error ? value.message : String(value)));
  }, [activeTabId, addressDraft, identity, panelError, runtime, runtimeError, views, activeViewId]);

  const retryNetworkError = useCallback(() => {
    if (activeTabId === null || !activeTab?.loadError) return;
    const url = activeTab.loadError.url || activeTab.url;
    setAddressError("");
    void window.desktop.browser
      .navigate(identity, activeTabId, url)
      .then((result) => {
        if (!result.ok && !result.loadError) setAddressError(result.error);
      })
      .catch((value: unknown) => setAddressError(value instanceof Error ? value.message : String(value)));
  }, [activeTab, activeTabId, identity]);

  // 标注模式瞬态清理（进入/退出共用）：清空编辑目标、输入文本、悬停目标与拾取
  // 错误，并递增模式代号使未完成的异步 hover/拾取结果失效；已保存的 annotations 保留。
  const resetAnnotationTransients = useCallback(() => {
    annotationModeGeneration.current += 1;
    lastHoverQuery.current = { x: -1000, y: -1000, time: 0 };
    setEditingTarget(null);
    setEditingAnnotation(null);
    setAnnotationText("");
    setHoverTarget(null);
    setPickError("");
  }, []);

  /** 取消当前标注编辑：清空编辑目标与输入文本（Escape 与编辑框“取消”按钮共用）。 */
  const cancelAnnotationEdit = useCallback(() => {
    setEditingTarget(null);
    setEditingAnnotation(null);
    setAnnotationText("");
  }, []);

  /** 退出标注模式（工具栏开关与 Escape 共用同一路径）：关闭模式并统一清理。 */
  const exitAnnotationMode = useCallback(() => {
    resetAnnotationTransients();
    setAnnotationMode(false);
  }, [resetAnnotationTransients]);

  // 标注模式开关：两个方向都从干净瞬态开始。
  const toggleAnnotationMode = useCallback(() => {
    resetAnnotationTransients();
    setAnnotationMode((current) => !current);
  }, [resetAnnotationTransients]);

  // 标注模式下的 Esc：编辑框打开时先取消编辑（清空输入文本），再按一次退出标注
  // 模式（退出与工具栏开关共用 exitAnnotationMode 同一路径）。
  useEffect(() => {
    if (!annotationMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editingTarget !== null || editingAnnotation !== null) {
        cancelAnnotationEdit();
        return;
      }
      exitAnnotationMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [annotationMode, editingTarget, editingAnnotation, cancelAnnotationEdit, exitAnnotationMode]);

  // 标注模式下定时重定位标注（页面滚动/重绘/动画后徽标跟随元素，1s 间隔）。
  useEffect(() => {
    const tabId = activeTabId;
    const generation = annotationGeneration.current;
    if (!annotationMode || tabId === null || annotations.length === 0) return;
    const timer = window.setInterval(() => {
      void window.desktop.browser
        .annotationList(identity, tabId)
        .then(async (list) => {
          if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
          const resolved = await Promise.all(
            list.map(async (annotation) => {
              const bounds = await window.desktop.browser.annotationResolve(identity, tabId, annotation.id);
              return [annotation.id, bounds] as const;
            }),
          );
          if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
          setAnnotations((current) =>
            current.map((annotation) => {
              const pair = resolved.find(([id]) => id === annotation.id);
              return pair && pair[1] ? { ...annotation, bounds: pair[1] } : annotation;
            }),
          );
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [annotationMode, activeTabId, annotations.length, identity]);

  // 标注模式点击拾取：坐标相对 viewport 容器（与 webview 视口一致）。
  // 标注拾取坐标基准：优先 webview 元素自身（与 guest 视口严格对齐），
  // 避免 overlay 容器与 webview 内容区之间的任何偏移；回退 overlay。
  const pickOrigin = useCallback(
    (fallback: HTMLElement): DOMRect | null => {
      const webview = activeViewId !== undefined ? webviewOf(runtime, activeViewId) : undefined;
      const rect = (webview ?? fallback).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    },
    [activeViewId, runtime, runtimeVersion],
  );

  const onAnnotationLayerMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (activeTabId === null || editingTarget !== null) return;
      const tabId = activeTabId;
      const origin = pickOrigin(event.currentTarget);
      if (origin === null) return;
      const x = Math.round(event.clientX - origin.left);
      const y = Math.round(event.clientY - origin.top);
      const now = performance.now();
      const last = lastHoverQuery.current;
      if (now - last.time < 120 && Math.hypot(x - last.x, y - last.y) < 8) return;
      lastHoverQuery.current = { x, y, time: now };
      const generation = annotationGeneration.current;
      const modeGeneration = annotationModeGeneration.current;
      void window.desktop.browser.annotationPick(identity, tabId, x, y).then((result) => {
        if (
          annotationModeGeneration.current !== modeGeneration ||
          annotationGeneration.current !== generation ||
          activeTabIdRef.current !== tabId
        )
          return;
        if (!result.ok) {
          setHoverTarget(null);
          return;
        }
        setHoverTarget({ ...result, pos: { x, y }, tabId, generation });
      });
    },
    [activeTabId, editingTarget, identity, pickOrigin],
  );

  const clearHover = useCallback(() => setHoverTarget(null), []);

  const onAnnotationLayerClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (activeTabId === null) return;
      const tabId = activeTabId;
      const origin = pickOrigin(event.currentTarget);
      if (origin === null) return;
      const x = Math.round(event.clientX - origin.left);
      const y = Math.round(event.clientY - origin.top);
      const generation = annotationGeneration.current;
      const modeGeneration = annotationModeGeneration.current;
      setPickError("");
      void window.desktop.browser.annotationPick(identity, tabId, x, y).then((result) => {
        if (
          annotationModeGeneration.current !== modeGeneration ||
          annotationGeneration.current !== generation ||
          activeTabIdRef.current !== tabId
        )
          return;
        if (!result.ok) {
          setPickError(result.error);
          return;
        }
        setEditingTarget({ ...result, pos: { x, y }, tabId, generation });
        setEditingAnnotation(null);
        setAnnotationText("");
      });
    },
    [activeTabId, identity, pickOrigin],
  );

  const saveAnnotation = useCallback(() => {
    const target = editingTarget;
    const tabId = activeTabId;
    if (
      tabId === null ||
      target === null ||
      target.tabId !== tabId ||
      target.generation !== annotationGeneration.current ||
      activeTabIdRef.current !== tabId
    ) {
      return;
    }
    const text = annotationText.trim();
    if (text.length === 0) return;
    void window.desktop.browser
      .annotationAdd(identity, tabId, {
        selector: target.selector,
        tag: target.tag,
        bounds: target.bounds,
        text,
      })
      .then((added) => {
        if (!added) return;
        if (target.generation !== annotationGeneration.current || activeTabIdRef.current !== tabId) {
          // 请求在 tab 切换/导航期间完成时回滚 main 侧已写入的孤儿标注。
          void window.desktop.browser.annotationRemove(identity, tabId, added.id);
          return;
        }
        setAnnotations((current) => [added, ...current]);
        setEditingTarget(null);
        setEditingAnnotation(null);
        setAnnotationText("");
        // 直接注入 composer 引用：标注作为用户 prompt 的起点（无需提交按钮）。
        // 携带元素名称与选择器，Agent 可用 browser_snapshot 对照定位（快照交互节点带 sel=）。
        const pageUrl = tabs.find((candidate) => candidate.tabId === tabId)?.url ?? "";
        const elementName = target.name.length > 0 ? `「${target.name}」` : "";
        const elementTag = [target.tag, elementName, target.selector].filter(Boolean).join(" ");
        const quote = {
          text: added.text,
          messageId: `browser-annotation:${added.id}`,
          tags: ["浏览器标注", elementTag, ...(pageUrl ? [pageUrl] : [])],
        };
        // 统一经桥接分发（composer 已挂载时同步追加，未挂载时排队）：bridge 据
        // 此登记 messageId -> (tabId, 创建时 URL)，URL 切换失效与消费清理才能定位引用。
        emitBrowserAnnotationToComposer({ targetKey: record.key, tabId, creationPageUrl: pageUrl, ...quote });
      })
      .catch(() => {
        if (target.generation === annotationGeneration.current && activeTabIdRef.current === tabId) {
          setPickError("保存标注失败");
        }
      });
  }, [activeTabId, annotationText, editingTarget, identity, record.key, tabs]);

  /** 保存已存在标注的编辑：原位 update（保持 id），并同步 composer 中同 messageId 引用。 */
  const saveAnnotationEdit = useCallback(() => {
    const annotation = editingAnnotation;
    const tabId = activeTabId;
    if (tabId === null || annotation === null || annotation.tabId !== tabId) return;
    const text = annotationText.trim();
    if (text.length === 0) return;
    const generation = annotationGeneration.current;
    void window.desktop.browser
      .annotationUpdate(identity, tabId, annotation.id, { text })
      .then((updated) => {
        if (!updated) return;
        if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
        setAnnotations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        setEditingAnnotation(null);
        setAnnotationText("");
        updateBrowserAnnotationInComposer(record.key, browserAnnotationMessageId(updated.id), updated.text);
      })
      .catch(() => {
        if (annotationGeneration.current === generation && activeTabIdRef.current === tabId) {
          setPickError("保存标注失败");
        }
      });
  }, [activeTabId, annotationText, editingAnnotation, identity, record.key]);

  const removeAnnotation = useCallback(
    (id: string) => {
      const tabId = activeTabId;
      const generation = annotationGeneration.current;
      if (tabId === null) return;
      void window.desktop.browser.annotationRemove(identity, tabId, id).then(() => {
        if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
        setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
        setEditingAnnotation((current) => (current?.id === id ? null : current));
        // 同步移除 composer 中尚未发送的同 messageId 引用，避免 quote 副本陈旧。
        removeBrowserAnnotationFromComposer(record.key, browserAnnotationMessageId(id));
      });
    },
    [activeTabId, identity, record.key],
  );

  // composer 成功发送后：main 批量消费本次已用的标注，并移除本 tab overlay。
  // IPC 删除失败时保留 overlay（main 侧标注仍在），登记待下次消费事件或
  // 面板重挂时合并重试；成功后才确认，避免未处理 rejection 与标注永久残留。
  useEffect(() => {
    return subscribeBrowserAnnotationConsumed(record.key, (event) => {
      if (event.messageIds.length === 0) return;
      const generation = annotationGeneration.current;
      // IPC 使用剥离前缀后的裸 annotation id；fail/ack 登记必须使用完整 messageId
      // （与 bridge 待重试队列同单位，重试事件原样交回本 handler 后再剥离前缀）。
      const annotationIds = event.messageIds.map((messageId) =>
        messageId.slice(BROWSER_ANNOTATION_QUOTE_PREFIX.length),
      );
      window.desktop.browser
        .annotationRemoveMany(identity, annotationIds)
        .then(() => {
          acknowledgeBrowserAnnotationRemoval(record.key, event.messageIds);
          if (annotationGeneration.current !== generation) return;
          setAnnotations((current) => current.filter((annotation) => !annotationIds.includes(annotation.id)));
        })
        .catch(() => {
          // 删除失败：main 侧标注保留，登记待重试（下次消费事件或面板重挂）。
          failBrowserAnnotationRemoval(record.key, event.messageIds);
        });
    });
  }, [identity, record.key]);

  const onToolbarBack = useCallback(() => {
    if (activeViewId === undefined) return;
    webviewOf(runtime, activeViewId)?.goBack();
  }, [activeViewId, runtime, runtimeVersion]);

  const onToolbarForward = useCallback(() => {
    if (activeViewId === undefined) return;
    webviewOf(runtime, activeViewId)?.goForward();
  }, [activeViewId, runtime, runtimeVersion]);

  const onToolbarReloadOrStop = useCallback(() => {
    if (activeViewId === undefined) return;
    const element = webviewOf(runtime, activeViewId);
    if (!element) return;
    if (element.isLoading()) element.stop();
    else element.reload();
  }, [activeViewId, runtime, runtimeVersion]);

  const handleSelectTab = useCallback(
    (tabId: number) => {
      void window.desktop.browser.selectTab(identity, tabId);
    },
    [identity],
  );

  const handleCloseView = useCallback(
    (viewId: number) => {
      closeView(runtime, viewId);
      if (runtime.views.length > 0) return;
      // 最后一个标签页关闭：同时关闭浏览器面板。若无其他面板 tab（如终端）
      // 则收起面板容器；有则只关闭浏览器 tab。
      const browserTabKey = workbenchPanelTabKey(BROWSER_PANEL_KIND);
      const hasOtherTabs = workbenchTabs.tabs.some((tab) => workbenchTabKey(tab) !== browserTabKey);
      workbenchTabs.closeTab(browserTabKey);
      if (!hasOtherTabs) updateWorkbench({ panelOpen: false });
    },
    [runtime, updateWorkbench, workbenchTabs],
  );

  const handleAddView = useCallback(() => {
    createBlankView(runtime);
  }, [runtime]);

  const handleRebuildView = useCallback(
    (viewId: number) => {
      rebuildView(runtime, viewId);
    },
    [runtime],
  );

  // 标注编辑器：新建（拾取目标）与已保存标注原位编辑共用同一编辑框。
  const annotationEditor = editingAnnotation ?? editingTarget;
  const annotationEditorPos =
    annotationEditor === null
      ? { x: 0, y: 0 }
      : "pos" in annotationEditor
        ? annotationEditor.pos
        : { x: annotationEditor.bounds.x, y: annotationEditor.bounds.y };

  return (
    <div className="browser-panel">
      <div className="browser-toolbar" role="toolbar" aria-label="浏览器工具">
        <TooltipIconButton tooltip="后退" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={onToolbarBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="前进"
          aria-label="前进"
          disabled={!activeTab?.canGoForward}
          onClick={onToolbarForward}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={activeTab?.loading ? "停止" : "刷新"}
          aria-label={activeTab?.loading ? "停止" : "刷新"}
          onClick={onToolbarReloadOrStop}
        >
          {activeTab?.loading ? (
            <LoaderCircle className="browser-tool-loading-icon" size={15} aria-hidden="true" />
          ) : (
            <RotateCw size={15} aria-hidden="true" />
          )}
        </TooltipIconButton>
        <div className="browser-address-wrap">
          <input
            className="browser-address"
            type="text"
            aria-label="地址栏"
            placeholder="输入网址或搜索历史，例如 example.com"
            spellCheck={false}
            value={addressDraft}
            onChange={(event) => {
              setAddressDraft(event.target.value);
              setAddressError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitAddress();
              if (event.key === "Escape") setAddressFocused(false);
            }}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
          />
          {addressFocused &&
            (() => {
              const query = addressDraft.trim().toLowerCase();
              const matches = historyEntries
                .filter(
                  (entry) =>
                    query.length === 0 ||
                    entry.url.toLowerCase().includes(query) ||
                    entry.title.toLowerCase().includes(query),
                )
                .slice(0, 10);
              if (matches.length === 0) return null;
              return (
                <div className="browser-history-popover" role="listbox" aria-label="历史记录">
                  {matches.map((entry) => (
                    <button
                      key={`${entry.url}-${entry.timestamp}`}
                      type="button"
                      className="browser-history-item"
                      role="option"
                      title={entry.url}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => navigateCurrentTabToUrl(entry.url)}
                    >
                      <HistoryIcon size={13} aria-hidden="true" />
                      <span className="browser-history-item-text">
                        <span className="browser-history-item-title">{entry.title || entry.url}</span>
                        <span className="browser-history-item-url">{entry.url}</span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })()}
        </div>
        <AnnotationModeToggle active={annotationMode} onToggle={toggleAnnotationMode} />
        <DropdownMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip="更多选项" aria-label="更多选项" data-active={moreMenuOpen || undefined}>
              <MoreVertical size={15} aria-hidden="true" />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="browser-more-dropdown-content">
            <DropdownMenuItem onSelect={openFindBar}>在页面中查找</DropdownMenuItem>
            <DropdownMenuItem onSelect={printPage}>打印</DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="browser-more-zoom-row">
              <span>缩放</span>
              <div className="browser-more-zoom-controls">
                <button
                  type="button"
                  className="browser-more-zoom-control"
                  aria-label="缩小页面"
                  disabled={activeViewId === undefined}
                  onClick={() => adjustPageZoom(-0.1)}
                >
                  <Minus size={13} aria-hidden="true" />
                </button>
                <span className="browser-more-zoom-value" aria-live="polite">
                  {Math.round(pageZoom * 100)}%
                </span>
                <button
                  type="button"
                  className="browser-more-zoom-control"
                  aria-label="放大页面"
                  disabled={activeViewId === undefined}
                  onClick={() => adjustPageZoom(0.1)}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                className="browser-more-reset-zoom"
                aria-label="重置页面缩放"
                disabled={activeViewId === undefined || Math.round(pageZoom * 100) === 100}
                onClick={() => setPageZoomFactor(1)}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openDeviceToolbar}>显示设备工具栏</DropdownMenuItem>
            <DropdownMenuItem onSelect={capturePageScreenshot}>截取屏幕截图</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openInternalPage("history")}>历史记录</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={showImportNotice}>导入 Cookie 和密码...</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>密码和自动填充</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="browser-more-dropdown-subcontent">
                <DropdownMenuItem onSelect={() => openInternalPage("passwords")}>密码管理器</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openInternalPage("contacts")}>联系人</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={openDownloadsPage}>下载</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>清除浏览数据</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="browser-more-dropdown-subcontent">
                <DropdownMenuItem onSelect={clearBrowserData}>清除 Cookie</DropdownMenuItem>
                <DropdownMenuItem onSelect={clearBrowserData}>清除缓存</DropdownMenuItem>
                <DropdownMenuItem onSelect={clearDownloadHistory}>删除下载历史记录</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => openInternalPage("site-settings")}>网站设置</DropdownMenuItem>
            <DropdownMenuItem onSelect={openBrowserSettings}>浏览器设置</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {findOpen ? (
        <div className="browser-find-bar" role="search" aria-label="在页面中查找">
          <Search size={14} aria-hidden="true" />
          <input
            ref={findInputRef}
            className="browser-find-input"
            type="search"
            aria-label="查找页面文本"
            placeholder="在页面中查找"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                findNext(!event.shiftKey);
              }
              if (event.key === "Escape") closeFindBar();
            }}
          />
          <span className="browser-find-result" aria-live="polite">
            {findQuery.length > 0 ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : ""}
          </span>
          <button
            type="button"
            className="browser-find-control"
            aria-label="上一个匹配项"
            disabled={findQuery.length === 0 || findResult.matches === 0}
            onClick={() => findNext(false)}
          >
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="browser-find-control"
            aria-label="下一个匹配项"
            disabled={findQuery.length === 0 || findResult.matches === 0}
            onClick={() => findNext(true)}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <button type="button" className="browser-find-control" aria-label="关闭查找" onClick={closeFindBar}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="browser-tabs">
        <div className="browser-tab-list" role="tablist" aria-label="浏览器标签页">
          {views.map((view) => {
            const tab = tabs.find((item) => item.tabId === tabIdOfView(runtime, view.viewId));
            const displayUrl = displayUrlOf(tab?.url ?? "", view.pendingUrl);
            const label = tab?.title || displayUrl || "新标签页";
            const active = tab?.tabId === activeTabId && !view.crashed;
            return (
              <div
                key={view.viewId}
                className="browser-tab"
                data-active={active || undefined}
                data-crashed={view.crashed || undefined}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (tab && !view.crashed) handleSelectTab(tab.tabId);
                }}
              >
                <span className="browser-tab-title">{label}</span>
                <TooltipIconButton
                  tooltip={`关闭 ${label}`}
                  aria-label={`关闭 ${label}`}
                  variant="ghost-destructive"
                  className="browser-tab-close size-4.5"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseView(view.viewId);
                  }}
                >
                  <X size={10} aria-hidden="true" />
                </TooltipIconButton>
              </div>
            );
          })}
        </div>
        <TooltipIconButton tooltip="新建标签页" aria-label="新建标签页" className="self-center" onClick={handleAddView}>
          <Plus size={15} aria-hidden="true" />
        </TooltipIconButton>
      </div>
      <div className="browser-viewport-shell">
        {deviceToolbarOpen ? (
          <div className="browser-device-toolbar" role="toolbar" aria-label="设备工具栏">
            <label className="browser-device-size-label">
              <span>尺寸:</span>
              <select
                className="browser-device-preset"
                aria-label="设备尺寸"
                value={devicePreset}
                onChange={(event) => selectDevicePreset(event.target.value as BrowserDevicePresetId)}
              >
                {BROWSER_DEVICE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="browser-device-dimensions" aria-label="视口尺寸">
              <input
                className="browser-device-dimension-input"
                aria-label="视口宽度"
                type="number"
                min={320}
                max={3_840}
                value={deviceWidth}
                onChange={(event) => updateDeviceWidth(event.target.value)}
              />
              <span aria-hidden="true">×</span>
              <input
                className="browser-device-dimension-input"
                aria-label="视口高度"
                type="number"
                min={240}
                max={2_160}
                value={deviceHeight}
                onChange={(event) => updateDeviceHeight(event.target.value)}
              />
            </div>
            <TooltipIconButton tooltip="旋转设备视口" aria-label="旋转设备视口" onClick={rotateDeviceViewport}>
              <RotateCcw size={15} aria-hidden="true" />
            </TooltipIconButton>
            <label className="browser-device-zoom">
              <select
                className="browser-device-zoom-select"
                aria-label="设备预览缩放"
                value={deviceZoomPercent}
                onChange={(event) => setDeviceZoom(Number(event.target.value))}
              >
                {[50, 75, 100, 125, 150, 200].map((percent) => (
                  <option key={percent} value={percent}>
                    {percent}%
                  </option>
                ))}
              </select>
            </label>
            <TooltipIconButton
              tooltip="关闭设备工具栏"
              aria-label="关闭设备工具栏"
              className="browser-device-toolbar-close"
              onClick={() => setDeviceToolbarOpen(false)}
            >
              <X size={14} aria-hidden="true" />
            </TooltipIconButton>
          </div>
        ) : null}
        <div className="browser-viewport" ref={viewportEl} data-device-toolbar={deviceToolbarOpen || undefined}>
          {passwordOffer ? (
            <div className="browser-password-offer" role="status" aria-label="是否保存密码">
              <span className="browser-password-offer-text">
                保存 <strong>{passwordOffer.origin}</strong> 的登录信息？
              </span>
              <span className="browser-password-offer-actions">
                <button
                  type="button"
                  className="browser-password-offer-ignore"
                  onClick={() => resolvePasswordOffer(false)}
                >
                  忽略
                </button>
                <button
                  type="button"
                  className="browser-password-offer-save"
                  onClick={() => resolvePasswordOffer(true)}
                >
                  保存密码
                </button>
              </span>
            </div>
          ) : null}
          {activeViewId !== undefined && !(views.find((view) => view.viewId === activeViewId)?.crashed ?? false) ? (
            <>
              {activeTab?.loading ? (
                <div className="browser-loading-indicator" role="status" aria-label="正在加载页面" />
              ) : null}
              {annotationMode && !activeTab?.loadError ? (
                <div className="browser-annotation-layer" aria-label="标注模式">
                  <div
                    className="browser-annotation-hitarea"
                    onClick={onAnnotationLayerClick}
                    onMouseMove={onAnnotationLayerMove}
                    onMouseLeave={clearHover}
                    aria-label="点击页面元素添加标注"
                  />
                  {hoverTarget && !editingTarget && (
                    <>
                      <div
                        className="browser-annotation-hover-box"
                        style={{
                          left: `${hoverTarget.bounds.x}px`,
                          top: `${hoverTarget.bounds.y}px`,
                          width: `${hoverTarget.bounds.width}px`,
                          height: `${hoverTarget.bounds.height}px`,
                        }}
                      />
                      <div
                        className="browser-annotation-tooltip"
                        style={{
                          left: `${Math.min(hoverTarget.pos.x + 14, Math.max(0, viewportSize.width - 260))}px`,
                          top: `${Math.min(hoverTarget.pos.y + 14, Math.max(0, viewportSize.height - 60))}px`,
                        }}
                      >
                        <span className="browser-annotation-tooltip-tag">{hoverTarget.tag}</span>
                        <span className="browser-annotation-tooltip-name" title={hoverTarget.selector}>
                          {hoverTarget.name || hoverTarget.selector}
                        </span>
                      </div>
                    </>
                  )}
                  {annotations.map((annotation, index) => (
                    <BrowserAnnotationMarker
                      key={annotation.id}
                      annotation={annotation}
                      index={index}
                      onEdit={() => {
                        // 点击已保存标注本体：原位编辑（预填文本，保持原 id）。
                        setEditingTarget(null);
                        setEditingAnnotation(annotation);
                        setAnnotationText(annotation.text);
                      }}
                      onRemove={() => removeAnnotation(annotation.id)}
                    />
                  ))}
                  {pickError && (
                    <div className="browser-annotation-error" role="alert">
                      {pickError}
                    </div>
                  )}
                  {annotationEditor && (
                    <div
                      className="browser-annotation-editor"
                      style={{
                        left: `${Math.min(annotationEditorPos.x, Math.max(0, viewportSize.width - 260))}px`,
                        top: `${Math.min(annotationEditorPos.y + 16, Math.max(0, viewportSize.height - 160))}px`,
                      }}
                      role="dialog"
                      aria-label={editingAnnotation ? "编辑标注" : "添加标注"}
                    >
                      <div className="browser-annotation-editor-heading">
                        <span className="browser-annotation-editor-tag">{annotationEditor.tag}</span>
                        <span className="browser-annotation-editor-name">
                          {"name" in annotationEditor
                            ? annotationEditor.name || annotationEditor.selector
                            : annotationEditor.selector}
                        </span>
                      </div>
                      <textarea
                        className="browser-annotation-input"
                        aria-label="标注内容"
                        placeholder="写下对元素的要求或反馈…"
                        value={annotationText}
                        onChange={(event) => setAnnotationText(event.target.value)}
                        onKeyDown={(event) => {
                          // Escape 由 window keydown 监听统一处理（第一次取消编辑，第二次退出）。
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            if (editingAnnotation) saveAnnotationEdit();
                            else saveAnnotation();
                          }
                        }}
                        autoFocus
                      />
                      <div className="browser-annotation-editor-actions">
                        <button type="button" className="browser-annotation-cancel" onClick={cancelAnnotationEdit}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="browser-annotation-save"
                          disabled={annotationText.trim().length === 0}
                          onClick={editingAnnotation ? saveAnnotationEdit : saveAnnotation}
                        >
                          保存标注
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
              {activeTab?.loadError ? (
                <BrowserNetworkErrorPage error={activeTab.loadError} onRetry={retryNetworkError} />
              ) : null}
              {bottomError && (
                <div className="browser-panel-error" role="alert">
                  <span className="browser-panel-error-text" title={bottomError}>
                    {bottomError}
                  </span>
                  <button type="button" className="browser-panel-error-retry" onClick={retryBottomError}>
                    {panelError || runtimeError ? "重建视图" : "重试"}
                  </button>
                </div>
              )}
              {browserNotice ? (
                <div className="browser-panel-notice" role="status">
                  {browserNotice}
                </div>
              ) : null}
            </>
          ) : null}
          {views.find((view) => view.viewId === activeViewId)?.crashed ? (
            <div className="browser-crash-overlay" role="alert">
              <strong>页面已崩溃</strong>
              <span>渲染进程异常退出，可重建该标签页</span>
              <button
                type="button"
                className="browser-rebuild-button"
                onClick={() => {
                  if (activeViewId !== undefined) handleRebuildView(activeViewId);
                }}
              >
                重建
              </button>
            </div>
          ) : null}
          {activeTabId !== null &&
          (activeUrl.length === 0 || activeUrl === "about:blank") &&
          !activeTab?.loading &&
          !activeTab?.loadError &&
          !panelError &&
          !runtimeError ? (
            <div className="browser-blank-state" aria-live="polite">
              <strong>开始浏览</strong>
              <span>输入 URL 以打开页面</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 读取会话持久化的 tab 快照（record 内存态优先，localStorage 兜底）。 */
function readStoredSessionSnapshot(
  sessionKey: string,
  cached: SessionBrowserUiSnapshot | undefined,
): SessionBrowserUiSnapshot {
  let stored: SessionBrowserUiSnapshot = { urls: [], activeIndex: 0 };
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(sessionKey));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "urls" in parsed &&
      Array.isArray(parsed.urls) &&
      "activeIndex" in parsed &&
      typeof parsed.activeIndex === "number"
    ) {
      stored = {
        urls: parsed.urls.filter((url): url is string => typeof url === "string"),
        activeIndex: parsed.activeIndex,
      };
    }
  } catch {
    stored = { urls: [], activeIndex: 0 };
  }
  // record 内存态是当前 renderer 生命周期最新值，避免已关闭的旧 URL 复活。
  // 不去重：会话内允许多个相同 URL 的标签，恢复时应保持一致。
  return normalizeBrowserSessionSnapshot(cached ?? stored);
}
