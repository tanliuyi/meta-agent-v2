import { useAui } from "@assistant-ui/react";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.mjs";
import HistoryIcon from "lucide-react/dist/esm/icons/history.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import MessageSquareQuote from "lucide-react/dist/esm/icons/message-square-quote.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserAnnotation,
  BrowserAnnotationBounds,
  BrowserAnnotationPickResult,
  BrowserHistoryEntry,
  BrowserStateEvent,
  BrowserTab,
} from "../../../../../shared/browser-contracts.ts";
import { appendComposerQuote } from "../../../runtime/composer-quotes.ts";
import { emitBrowserAnnotationToComposer } from "../../../state/browser-composer-bridge.ts";
import type { BrowserWebviewElement } from "../../../webview.d.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope } from "../../session-context.tsx";
import { consumeCreateTabRequests, takeAllPendingCreateTabRequests } from "./browser-pending-requests.ts";

/**
 * 内置浏览器（IAB）面板（P0）。
 *
 * 每个 tab 对应一个 `<webview partition="persist:browser">` 标签（guest 归属
 * main 进程）。renderer 在 webview attach 后把 guest webContentsId 交给
 * BrowserManager 注册，导航/截图/状态由 main 驱动，tab 列表与活跃 tab 以
 * `browserStateChanged` 广播为唯一状态源；本组件只维护 view 元素、attach
 * 映射与本地 UI 状态（地址栏草稿、崩溃占位）。
 *
 * P0 约束：back/forward/reload 走 webview 元素原生方法（导航事件仍会被
 * main 捕获并广播）；弹窗默认禁用（不设 allowpopups）暂不处理，P1 转 tab。
 */

/** renderer 侧一个浏览器视图（对应一个 <webview> 元素）。 */
interface BrowserViewRecord {
  /** renderer 本地自增 id，作为 React key 与元素映射键。 */
  viewId: number;
  /** guest 渲染进程崩溃，占位待重建。 */
  crashed: boolean;
  /** 创建/重建后希望打开的 URL（空 = 保持 about:blank）。 */
  pendingUrl: string;
  /** main 建 tab 请求的 requestId（attach 时传给 main，由其 resolve 并自动导航）。 */
  pendingRequestId?: number;
  /** 强制重建 webview 元素的递增号（attach 失败/卡住时用）。 */
  remountEpoch?: number;
}

interface AnnotationTarget extends Extract<BrowserAnnotationPickResult, { ok: true }> {
  pos: { x: number; y: number };
  tabId: number;
  generation: number;
}

/** 面板卸载时保存的 tab URL 快照；重新挂载时恢复（workbench 面板切换会卸载本组件）。 */
const BROWSER_SESSION_STORAGE_KEY = "meta-agent.browser.session.v1";
let lastBrowserSession: string[] = [];

/** 初始视图列表：优先消费 main 的建 tab 请求，其次恢复上次面板会话 URL，否则一个空白 tab。 */
function initialViews(): BrowserViewRecord[] {
  const requests = takeAllPendingCreateTabRequests();
  if (requests.length > 0) {
    return requests.map((request, index) => ({
      viewId: index + 1,
      crashed: false,
      pendingUrl: request.url,
      pendingRequestId: request.requestId,
    }));
  }
  // 恢复由挂载后的 settings effect 决定，不能在同步初始化阶段绕过 restoreTabsOnLaunch。
  return [{ viewId: 1, crashed: false, pendingUrl: "" }];
}

/** 地址栏输入规范化：空忽略；带协议原样；否则补 https://。 */
function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 浏览器面板（会话无关的全局服务面板；在 workbench panel 内挂载）。 */
export function BrowserPanel() {
  const aui = useAui();
  const { record } = useSessionScope();
  const [views, setViews] = useState<BrowserViewRecord[]>(initialViews);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [historyEntries, setHistoryEntries] = useState<BrowserHistoryEntry[]>([]);
  // 标注模式（§11）：开关、当前 tab 标注、正在编辑的目标与编辑框位置。
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);
  const [editingTarget, setEditingTarget] = useState<AnnotationTarget | null>(null);
  const [hoverTarget, setHoverTarget] = useState<AnnotationTarget | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [pickError, setPickError] = useState("");
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [panelError, setPanelError] = useState("");
  const viewportEl = useRef<HTMLDivElement | null>(null);

  const viewIdCounter = useRef(views.length);
  const viewsRef = useRef(views);
  const tabsRef = useRef(tabs);
  const viewEls = useRef(new Map<number, BrowserWebviewElement>());
  /** viewId → guest webContentsId（已 attach）。 */
  const webContentsIdByView = useRef(new Map<number, number>());
  /** viewId → BrowserManager 分配的 tabId。 */
  const tabIdByView = useRef(new Map<number, number>());
  /** tabId → viewId。 */
  const viewIdByTabId = useRef(new Map<number, number>());
  const activeTabIdRef = useRef(activeTabId);
  const annotationGeneration = useRef(0);
  const attachGenerationByView = useRef(new Map<number, number>());

  viewsRef.current = views;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const createView = useCallback((pendingUrl = "", pendingRequestId?: number): BrowserViewRecord => {
    viewIdCounter.current += 1;
    return { viewId: viewIdCounter.current, crashed: false, pendingUrl, pendingRequestId };
  }, []);

  // 首次挂载/应用重启按持久设置恢复 URL；工具建 tab 请求优先，不覆盖已有视图。
  useEffect(() => {
    let cancelled = false;
    void window.desktop.browser
      .getSettings()
      .then((snapshot) => {
        if (cancelled || !snapshot.settings.restoreTabsOnLaunch) return;
        const stored = (() => {
          try {
            const raw = window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === "string") : [];
          } catch {
            return [];
          }
        })();
        const urls = [...lastBrowserSession, ...stored].filter(
          (url, index, all) => url.length > 0 && all.indexOf(url) === index,
        );
        if (urls.length === 0) return;
        const existingView = viewsRef.current.length === 1 ? viewsRef.current[0] : undefined;
        const existingTabId = existingView ? tabIdByView.current.get(existingView.viewId) : undefined;
        if (existingTabId !== undefined) {
          void window.desktop.browser.navigate(existingTabId, urls[0]!);
        }
        setViews((prev) => {
          if (prev.length !== 1 || prev[0]?.pendingUrl !== "" || prev[0]?.pendingRequestId !== undefined) return prev;
          const firstViewId = prev[0]!.viewId;
          viewIdCounter.current = firstViewId + urls.length - 1;
          return urls.map((url, index) => ({
            viewId: firstViewId + index,
            crashed: false,
            pendingUrl: url,
          }));
        });
        lastBrowserSession = [];
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // attach：webview did-attach / dom-ready 后把 guest webContentsId 交给 main。
  // 带 pendingRequestId 时由 main resolve 建 tab 请求并自动导航；否则本地导航 pendingUrl。
  // quiet 模式（挂载后主动检查）下未就绪不报错，交给事件回调；事件回调失败才提示。
  const attachView = useCallback((viewId: number, element: BrowserWebviewElement, quiet = false) => {
    if (webContentsIdByView.current.has(viewId) || viewEls.current.get(viewId) !== element) return;
    let webContentsId: number;
    try {
      // webview 未 attach / dom-ready 未发出时该方法抛异常（而非返回 -1）。
      webContentsId = element.getWebContentsId();
    } catch {
      if (!quiet) setPanelError("webview 尚未就绪（guest 未 attach），请点击「重建视图」重试");
      return;
    }
    if (webContentsId <= 0) {
      if (!quiet) setPanelError("webview 尚未就绪（guest 未 attach），请点击「重建视图」重试");
      return;
    }
    const generation = (attachGenerationByView.current.get(viewId) ?? 0) + 1;
    attachGenerationByView.current.set(viewId, generation);
    setPanelError("");
    webContentsIdByView.current.set(viewId, webContentsId);
    const record = viewsRef.current.find((view) => view.viewId === viewId);
    const requestId = record?.pendingRequestId;
    const isCurrent = () =>
      attachGenerationByView.current.get(viewId) === generation &&
      viewEls.current.get(viewId) === element &&
      webContentsIdByView.current.get(viewId) === webContentsId;
    void window.desktop.browser
      .attach(webContentsId, requestId)
      .then((result) => {
        if (!isCurrent()) {
          // attach 迟到时主进程可能已登记该 guest；立即释放，不能污染新视图。
          if (result.ok) void window.desktop.browser.detach(webContentsId);
          return;
        }
        if (!result.ok) {
          setPanelError(`浏览器连接失败：${result.error}`);
          webContentsIdByView.current.delete(viewId);
          setViews((prev) =>
            prev.map((view) => (view.viewId === viewId ? { ...view, pendingRequestId: undefined } : view)),
          );
          void window.desktop.browser.detach(webContentsId);
          return;
        }
        tabIdByView.current.set(viewId, result.tab.tabId);
        viewIdByTabId.current.set(result.tab.tabId, viewId);
        // 请求已由 main 接管，清除 requestId 标记，避免重建时重复走请求路径。
        setViews((prev) =>
          prev.map((view) => (view.viewId === viewId ? { ...view, pendingRequestId: undefined } : view)),
        );
        const latest = viewsRef.current.find((view) => view.viewId === viewId);
        if (latest && latest.pendingUrl && requestId === undefined) {
          void window.desktop.browser.navigate(result.tab.tabId, latest.pendingUrl);
        }
      })
      .catch((value: unknown) => {
        if (!isCurrent()) return;
        webContentsIdByView.current.delete(viewId);
        setPanelError(`浏览器连接失败：${value instanceof Error ? value.message : String(value)}`);
      });
  }, []);

  // 崩溃：detach 让 main 移除 crashed tab，本视图切到占位，记录恢复 URL。
  const handleCrash = useCallback((viewId: number, sourceElement?: BrowserWebviewElement) => {
    if (sourceElement !== undefined && viewEls.current.get(viewId) !== sourceElement) return;
    attachGenerationByView.current.set(viewId, (attachGenerationByView.current.get(viewId) ?? 0) + 1);
    const tabId = tabIdByView.current.get(viewId);
    let url = "";
    if (tabId !== undefined) {
      url = tabsRef.current.find((tab) => tab.tabId === tabId)?.url ?? "";
      viewIdByTabId.current.delete(tabId);
      tabIdByView.current.delete(viewId);
    }
    const webContentsId = webContentsIdByView.current.get(viewId);
    if (webContentsId !== undefined) {
      webContentsIdByView.current.delete(viewId);
      void window.desktop.browser.detach(webContentsId);
    }
    setViews((prev) =>
      prev.map((view) => (view.viewId === viewId ? { ...view, crashed: true, pendingUrl: url } : view)),
    );
  }, []);

  const rebuildView = useCallback((viewId: number) => {
    const record = viewsRef.current.find((view) => view.viewId === viewId);
    if (!record) return;
    setViews((prev) =>
      prev.map((view) => (view.viewId === viewId ? { ...view, crashed: false, pendingUrl: record.pendingUrl } : view)),
    );
  }, []);

  const closeView = useCallback(
    (viewId: number) => {
      attachGenerationByView.current.set(viewId, (attachGenerationByView.current.get(viewId) ?? 0) + 1);
      const webContentsId = webContentsIdByView.current.get(viewId);
      if (webContentsId !== undefined) {
        webContentsIdByView.current.delete(viewId);
        void window.desktop.browser.detach(webContentsId);
      }
      const tabId = tabIdByView.current.get(viewId);
      if (tabId !== undefined) {
        viewIdByTabId.current.delete(tabId);
        tabIdByView.current.delete(viewId);
      }
      setViews((prev) => {
        const next = prev.filter((view) => view.viewId !== viewId);
        // 保持至少一个视图；全部关闭后补一个空白 tab。
        return next.length === 0 ? [createView()] : next;
      });
    },
    [createView],
  );

  const addView = useCallback(() => {
    setViews((prev) => [...prev, createView()]);
  }, [createView]);

  // 重建指定视图的 webview 元素（attach 失败/卡住时强制重挂载）。
  const remountView = useCallback((viewId: number) => {
    const record = viewsRef.current.find((view) => view.viewId === viewId);
    if (!record) return;
    const tabId = tabIdByView.current.get(viewId);
    const webContentsId = webContentsIdByView.current.get(viewId);
    const pendingUrl =
      (tabId !== undefined ? tabsRef.current.find((tab) => tab.tabId === tabId)?.url : undefined) ?? record.pendingUrl;
    attachGenerationByView.current.set(viewId, (attachGenerationByView.current.get(viewId) ?? 0) + 1);
    if (webContentsId !== undefined) {
      webContentsIdByView.current.delete(viewId);
      void window.desktop.browser.detach(webContentsId);
    }
    if (tabId !== undefined) {
      viewIdByTabId.current.delete(tabId);
      tabIdByView.current.delete(viewId);
    }
    setPanelError("");
    setViews((prev) =>
      prev.map((view) =>
        view.viewId === viewId
          ? {
              ...view,
              crashed: false,
              pendingUrl,
              pendingRequestId: undefined,
              remountEpoch: (view.remountEpoch ?? 0) + 1,
            }
          : view,
      ),
    );
  }, []);

  // main 状态广播是 tabs 的唯一状态源；同时订阅面板挂载后到达的建 tab 请求。
  useEffect(() => {
    const onState = (event: BrowserStateEvent) => {
      const liveTabIds = new Set(event.tabs.map((tab) => tab.tabId));
      const staleViewIds: Array<{ viewId: number; pendingUrl: string }> = [];
      for (const [viewId, tabId] of tabIdByView.current) {
        if (liveTabIds.has(tabId)) continue;
        const pendingUrl = tabsRef.current.find((tab) => tab.tabId === tabId)?.url ?? "";
        staleViewIds.push({ viewId, pendingUrl });
        attachGenerationByView.current.set(viewId, (attachGenerationByView.current.get(viewId) ?? 0) + 1);
        tabIdByView.current.delete(viewId);
        viewIdByTabId.current.delete(tabId);
        webContentsIdByView.current.delete(viewId);
      }
      if (staleViewIds.length > 0) {
        setViews((prev) =>
          prev.map((view) => {
            const stale = staleViewIds.find((item) => item.viewId === view.viewId);
            return stale
              ? { ...view, crashed: false, pendingUrl: stale.pendingUrl, remountEpoch: (view.remountEpoch ?? 0) + 1 }
              : view;
          }),
        );
      }
      setTabs(event.tabs);
      setActiveTabId(event.activeTabId);
    };
    const unsubscribe = window.desktop.browser.onStateChanged(onState);
    const unsubscribeCreate = consumeCreateTabRequests((request) => {
      setViews((prev) => [...prev, createView(request.url, request.requestId)]);
    });
    // 面板卸载时保存当前 tab URL（下次挂载恢复），并清理全部已注册 guest。
    return () => {
      annotationGeneration.current += 1;
      unsubscribe();
      unsubscribeCreate();
      const urls = tabsRef.current.map((tab) => tab.url).filter((url) => url.length > 0);
      lastBrowserSession = urls;
      try {
        window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(urls));
      } catch {
        // localStorage 不可用时仍保留当前 renderer 生命周期的内存会话。
      }
      for (const webContentsId of webContentsIdByView.current.values()) {
        void window.desktop.browser.detach(webContentsId);
      }
      webContentsIdByView.current.clear();
      for (const [viewId, tabId] of tabIdByView.current) {
        void tabId;
        viewIdByTabId.current.delete(tabId);
        tabIdByView.current.delete(viewId);
      }
      attachGenerationByView.current.clear();
    };
  }, [createView]);

  // 每个 view 绑定元素事件；ref 在 render 后可用。
  // did-attach 可能在监听器绑定前发出（竞态）：除事件外再轮询补查（500ms × 10）。
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const timers: number[] = [];
    for (const view of views) {
      const element = viewEls.current.get(view.viewId);
      if (!element || view.crashed) continue;
      const onAttach = () => attachView(view.viewId, element);
      const onGone = (event: Event) => {
        void event;
        handleCrash(view.viewId, element);
      };
      element.addEventListener("did-attach", onAttach);
      element.addEventListener("dom-ready", onAttach);
      element.addEventListener("render-process-gone", onGone);
      cleanups.push(() => {
        element.removeEventListener("did-attach", onAttach);
        element.removeEventListener("dom-ready", onAttach);
        element.removeEventListener("render-process-gone", onGone);
      });
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        if (webContentsIdByView.current.has(view.viewId)) {
          clearInterval(timer);
          return;
        }
        attachView(view.viewId, element, true);
        if (attempts >= 10) {
          clearInterval(timer);
          setPanelError("webview 未能建立连接（guest 未 attach），请点击「重建视图」重试");
        }
      }, 500);
      timers.push(timer);
    }
    return () => {
      for (const timer of timers) clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
    };
  }, [views, attachView, handleCrash]);

  // 地址栏跟随活跃 tab（用户输入中不覆盖；加载失败时保留输入便于修改重试）。
  useEffect(() => {
    if (addressFocused) return;
    const active = tabs.find((tab) => tab.tabId === activeTabId);
    const current = active?.url ?? "";
    if (active?.loadError && addressDraft.length > 0 && addressDraft !== current) return;
    setAddressDraft(current);
  }, [activeTabId, addressFocused, tabs, addressDraft]);

  const activeAnnotationUrl = tabs.find((tab) => tab.tabId === activeTabId)?.url ?? "";

  // 活跃 tab URL 变化时：刷新历史列表、拉取该 tab 标注、重定位标注 bounds。
  useEffect(() => {
    void window.desktop.browser
      .browserHistory()
      .then((entries) => {
        if (activeTabIdRef.current === activeTabId) setHistoryEntries(entries);
      })
      .catch(() => undefined);
    const tabId = activeTabId;
    const generation = annotationGeneration.current + 1;
    annotationGeneration.current = generation;
    setAnnotations([]);
    setEditingTarget(null);
    setHoverTarget(null);
    setPickError("");
    if (tabId === null) return;
    const isCurrent = () => annotationGeneration.current === generation && activeTabIdRef.current === tabId;
    let cancelled = false;
    const loadAnnotations = async (): Promise<void> => {
      const list = await window.desktop.browser.annotationList(tabId);
      if (cancelled || !isCurrent()) return;
      setAnnotations(list);
      const resolved = await Promise.all(
        list.map(async (annotation) => {
          const bounds = await window.desktop.browser.annotationResolve(tabId, annotation.id);
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
  }, [activeTabId, activeAnnotationUrl]);

  const activeViewId = activeTabId !== null ? viewIdByTabId.current.get(activeTabId) : undefined;
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;
  const activeUrl = activeTab?.url ?? "";

  const submitAddress = useCallback(() => {
    if (activeTabId === null) {
      setAddressError("没有可用的浏览器标签页");
      return;
    }
    const url = normalizeAddress(addressDraft);
    if (!url) {
      setAddressError("请输入有效的网址");
      return;
    }
    setAddressError("");
    void window.desktop.browser
      .navigate(activeTabId, url)
      .then((result) => {
        if (!result.ok) setAddressError(result.error);
      })
      .catch((value: unknown) => setAddressError(value instanceof Error ? value.message : String(value)));
  }, [activeTabId, addressDraft]);

  const navigateToUrl = useCallback(
    (url: string) => {
      if (activeTabId === null) return;
      setAddressDraft(url);
      setAddressFocused(false);
      setAddressError("");
      void window.desktop.browser.navigate(activeTabId, url).then((result) => {
        if (!result.ok) setAddressError(result.error);
      });
    },
    [activeTabId],
  );

  // 左下角统一错误条：attach 系统错误 > 用户操作错误 > 页面加载错误。
  const bottomError = panelError || addressError || activeTab?.loadError || "";

  const retryBottomError = useCallback(() => {
    if (panelError) {
      const viewId = activeViewId ?? views[0]?.viewId;
      if (viewId !== undefined) remountView(viewId);
      return;
    }
    if (activeTabId === null) return;
    // 加载失败重试当前页；其余用地址栏当前输入。
    const url = activeTab?.loadError ? activeTab.url : normalizeAddress(addressDraft);
    if (!url) return;
    setAddressError("");
    void window.desktop.browser
      .navigate(activeTabId, url)
      .then((result) => {
        if (!result.ok) setAddressError(result.error);
      })
      .catch((value: unknown) => setAddressError(value instanceof Error ? value.message : String(value)));
  }, [panelError, activeViewId, views, remountView, activeTabId, activeTab, addressDraft]);

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

  // 标注模式：关闭时清理编辑态。
  const toggleAnnotationMode = useCallback(() => {
    setAnnotationMode((current) => {
      const next = !current;
      if (!next) {
        setEditingTarget(null);
        setPickError("");
      }
      return next;
    });
  }, []);

  // 标注模式下的 Esc：编辑框打开时先关闭编辑框，再按一次退出标注模式。
  useEffect(() => {
    if (!annotationMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editingTarget !== null) {
        setEditingTarget(null);
        return;
      }
      setAnnotationMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [annotationMode, editingTarget]);

  // 标注模式下定时重定位标注（页面滚动/重绘/动画后徽标跟随元素，1s 间隔）。
  useEffect(() => {
    const tabId = activeTabId;
    const generation = annotationGeneration.current;
    if (!annotationMode || tabId === null || annotations.length === 0) return;
    const timer = window.setInterval(() => {
      void window.desktop.browser
        .annotationList(tabId)
        .then(async (list) => {
          if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
          const resolved = await Promise.all(
            list.map(async (annotation) => {
              const bounds = await window.desktop.browser.annotationResolve(tabId, annotation.id);
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
  }, [annotationMode, activeTabId, annotations.length]);

  // 标注模式点击拾取：坐标相对 viewport 容器（与 webview 视口一致）。
  // 标注模式 hover 拾取：节流（120ms）+ 移动距离阈值（8px），避免每帧 CDP。
  const lastHoverQuery = useRef({ x: -1000, y: -1000, time: 0 });
  // 标注拾取坐标基准：优先 webview 元素自身（与 guest 视口严格对齐），
  // 避免 overlay 容器与 webview 内容区之间的任何偏移；回退 overlay。
  const pickOrigin = useCallback(
    (fallback: HTMLElement): DOMRect | null => {
      const webview = activeViewId !== undefined ? viewEls.current.get(activeViewId) : undefined;
      const rect = (webview ?? fallback).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    },
    [activeViewId],
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
      void window.desktop.browser.annotationPick(tabId, x, y).then((result) => {
        if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
        if (!result.ok) {
          setHoverTarget(null);
          return;
        }
        setHoverTarget({ ...result, pos: { x, y }, tabId, generation });
      });
    },
    [activeTabId, editingTarget, activeViewId],
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
      setPickError("");
      void window.desktop.browser.annotationPick(tabId, x, y).then((result) => {
        if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
        if (!result.ok) {
          setPickError(result.error);
          return;
        }
        setEditingTarget({ ...result, pos: { x, y }, tabId, generation });
        setAnnotationText("");
      });
    },
    [activeTabId, activeViewId],
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
      .annotationAdd(tabId, {
        selector: target.selector,
        tag: target.tag,
        bounds: target.bounds,
        text,
      })
      .then((added) => {
        if (!added) return;
        if (target.generation !== annotationGeneration.current || activeTabIdRef.current !== tabId) {
          // 请求在 tab 切换/导航期间完成时回滚 main 侧已写入的孤儿标注。
          void window.desktop.browser.annotationRemove(tabId, added.id);
          return;
        }
        setAnnotations((current) => [added, ...current]);
        setEditingTarget(null);
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
        try {
          appendComposerQuote(aui.thread().composer(), quote);
        } catch {
          // 浏览器面板可能被挂载在无 thread runtime 的容器中，交给桥接队列稍后消费。
          emitBrowserAnnotationToComposer({ targetKey: record.key, ...quote });
        }
      })
      .catch(() => {
        if (target.generation === annotationGeneration.current && activeTabIdRef.current === tabId) {
          setPickError("保存标注失败");
        }
      });
  }, [activeTabId, annotationText, aui, editingTarget, record.key, tabs]);

  const removeAnnotation = useCallback(
    (id: string) => {
      const tabId = activeTabId;
      const generation = annotationGeneration.current;
      if (tabId === null) return;
      void window.desktop.browser.annotationRemove(tabId, id).then(() => {
        if (annotationGeneration.current !== generation || activeTabIdRef.current !== tabId) return;
        setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
      });
    },
    [activeTabId],
  );

  const onToolbarBack = useCallback(() => {
    if (activeViewId === undefined) return;
    viewEls.current.get(activeViewId)?.goBack();
  }, [activeViewId]);

  const onToolbarForward = useCallback(() => {
    if (activeViewId === undefined) return;
    viewEls.current.get(activeViewId)?.goForward();
  }, [activeViewId]);

  const onToolbarReloadOrStop = useCallback(() => {
    if (activeViewId === undefined) return;
    const element = viewEls.current.get(activeViewId);
    if (!element) return;
    if (element.isLoading()) element.stop();
    else element.reload();
  }, [activeViewId]);

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
                      onClick={() => navigateToUrl(entry.url)}
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
        <TooltipIconButton
          tooltip={annotationMode ? "退出标注模式" : "标注模式"}
          data-active={annotationMode || undefined}
          aria-label={annotationMode ? "退出标注模式" : "标注模式（点击页面元素添加注释）"}
          aria-pressed={annotationMode}
          onClick={toggleAnnotationMode}
        >
          <MessageSquareQuote size={15} aria-hidden="true" />
        </TooltipIconButton>
      </div>
      <div className="browser-tabs">
        <div className="browser-tab-list" role="tablist" aria-label="浏览器标签页">
          {views.map((view) => {
            const tabId = tabIdByView.current.get(view.viewId);
            const tab = tabId !== undefined ? tabs.find((item) => item.tabId === tabId) : undefined;
            const label = tab?.title || tab?.url || "新标签页";
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
                  if (tabId !== undefined && !view.crashed) {
                    void window.desktop.browser.selectTab(tabId);
                  }
                }}
              >
                <span className="browser-tab-title">{label}</span>
                <TooltipIconButton
                  tooltip={`关闭 ${label}`}
                  aria-label={`关闭 ${label}`}
                  variant="ghost-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeView(view.viewId);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </TooltipIconButton>
              </div>
            );
          })}
        </div>
        <TooltipIconButton tooltip="新建标签页" aria-label="新建标签页" className="self-center" onClick={addView}>
          <Plus size={15} aria-hidden="true" />
        </TooltipIconButton>
      </div>
      <div className="browser-viewport" ref={viewportEl}>
        {views.map((view) => {
          const tabId = tabIdByView.current.get(view.viewId);
          const active = tabId === activeTabId && !view.crashed;
          if (view.crashed) {
            return (
              <div key={view.viewId} className="browser-crash-overlay" role="alert">
                <strong>页面已崩溃</strong>
                <span>渲染进程异常退出，可重建该标签页</span>
                <button type="button" className="browser-rebuild-button" onClick={() => rebuildView(view.viewId)}>
                  重建
                </button>
              </div>
            );
          }
          return (
            <div
              key={view.viewId}
              className="browser-view-host"
              data-active={active || undefined}
              style={active ? undefined : { display: "none" }}
            >
              <webview
                key={view.remountEpoch ?? 0}
                ref={(element) => {
                  const webviewEl = element as BrowserWebviewElement | null;
                  if (webviewEl) viewEls.current.set(view.viewId, webviewEl);
                  else viewEls.current.delete(view.viewId);
                }}
                className="browser-webview"
                src="about:blank"
                partition="persist:browser"
                allowpopups={false}
                webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
              />
              {active && activeTab?.loading ? (
                <div className="browser-loading-indicator" role="status" aria-label="正在加载页面" />
              ) : null}
              {active && annotationMode ? (
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
                    <div
                      key={annotation.id}
                      className="browser-annotation-marker"
                      style={{
                        left: `${annotation.bounds.x}px`,
                        top: `${annotation.bounds.y}px`,
                        width: `${annotation.bounds.width}px`,
                        height: `${annotation.bounds.height}px`,
                      }}
                      title={annotation.text}
                    >
                      <span className="browser-annotation-badge">{index + 1}</span>
                      <span className="browser-annotation-text">{annotation.text}</span>
                      <span className="browser-annotation-remove-slot">
                        <TooltipIconButton
                          tooltip={`删除标注 ${index + 1}`}
                          aria-label={`删除标注 ${index + 1}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            removeAnnotation(annotation.id);
                          }}
                        >
                          <Trash2 size={11} aria-hidden="true" />
                        </TooltipIconButton>
                      </span>
                    </div>
                  ))}
                  {pickError && (
                    <div className="browser-annotation-error" role="alert">
                      {pickError}
                    </div>
                  )}
                  {editingTarget && (
                    <div
                      className="browser-annotation-editor"
                      style={{
                        left: `${Math.min(editingTarget.pos.x, Math.max(0, viewportSize.width - 260))}px`,
                        top: `${Math.min(editingTarget.pos.y + 16, Math.max(0, viewportSize.height - 160))}px`,
                      }}
                      role="dialog"
                      aria-label="添加标注"
                    >
                      <div className="browser-annotation-editor-heading">
                        <span className="browser-annotation-editor-tag">{editingTarget.tag}</span>
                        <span className="browser-annotation-editor-name">
                          {editingTarget.name || editingTarget.selector}
                        </span>
                      </div>
                      <textarea
                        className="browser-annotation-input"
                        aria-label="标注内容"
                        placeholder="写下对元素的要求或反馈…"
                        value={annotationText}
                        onChange={(event) => setAnnotationText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveAnnotation();
                          if (event.key === "Escape") setEditingTarget(null);
                        }}
                        autoFocus
                      />
                      <div className="browser-annotation-editor-actions">
                        <button
                          type="button"
                          className="browser-annotation-cancel"
                          onClick={() => setEditingTarget(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="browser-annotation-save"
                          disabled={annotationText.trim().length === 0}
                          onClick={saveAnnotation}
                        >
                          保存标注
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
              {active && bottomError && (
                <div className="browser-panel-error" role="alert">
                  <span className="browser-panel-error-text" title={bottomError}>
                    {bottomError}
                  </span>
                  <button type="button" className="browser-panel-error-retry" onClick={retryBottomError}>
                    {panelError ? "重建视图" : "重试"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {activeTabId !== null &&
        activeUrl === "about:blank" &&
        !activeTab?.loading &&
        !activeTab?.loadError &&
        !panelError ? (
          <div className="browser-blank-state" aria-live="polite">
            <strong>开始浏览</strong>
            <span>输入 URL 以打开页面</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
