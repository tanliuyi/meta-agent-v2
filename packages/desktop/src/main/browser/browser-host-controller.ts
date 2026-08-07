/**
 * BrowserManager 的宿主控制器：封装对单个 guest webContents 的控制与事件桥接。
 *
 * P0 使用 webContents 原生 API（loadURL / capturePage / 生命周期事件）。
 * P1 增加 CDP 元素级交互（Accessibility.getFullAXTree 快照、Input 事件、
 * Runtime.evaluate），debugger 按需 attach，命令经串行队列执行。
 *
 * 本接口保持宿主无关（spec D1.1：若 webview 稳定性不可接受，迁移
 * WebContentsView 时只换实现）。
 */

import type { NativeImage, WebContents } from "electron";
import type {
  BrowserAction,
  BrowserActionTarget,
  BrowserAnnotationBounds,
  BrowserNavigationState,
  BrowserSnapshot,
  BrowserSnapshotNode,
} from "../../shared/browser-contracts.ts";

/** 宿主向 BrowserManager 上报的浏览器事件（由 webContents 事件翻译而来）。 */
export type BrowserHostEvent =
  | { type: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { type: "navigated-in-page"; url: string }
  | { type: "title-updated"; title: string }
  | { type: "loading-changed"; loading: boolean }
  | { type: "load-failed"; url: string; code: number; description: string }
  | { type: "crashed"; reason: string }
  | { type: "destroyed" };

/** Agent 点击/导航期间的同步导航守卫。返回 false 时，宿主必须阻止 will-navigate。 */
export type AgentNavigationGuard = (url: string, currentUrl: string, approvedUrl?: string) => boolean;

/** WebContentsHostController 的运行时配置。 */
export interface WebContentsHostControllerOptions {
  cdpTimeoutMs?: number;
  maxSnapshotNodes?: number;
  onAgentNavigation?: AgentNavigationGuard;
  onPopup?: (url: string) => void;
}

/** 宿主无关的浏览器控制接口（一个实例对应一个 tab 的 guest webContents）。 */
export interface BrowserHostController {
  navigate(url: string, options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  goBack(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  goForward(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  reload(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  getNavigationState(): BrowserNavigationState;
  captureScreenshot(): Promise<{ dataUrl: string; width: number; height: number }>;
  snapshot(opts: { withScreenshot: boolean }): Promise<BrowserSnapshot>;
  performAction(action: BrowserAction, options?: { agent?: boolean }): Promise<{ url?: string; title?: string }>;
  inspectElement(elementIndex: number): BrowserSnapshotNode | null;
  clearData(): Promise<void>;
  updateSettings(options: { cdpTimeoutMs: number; maxSnapshotNodes: number }): void;
  cancelPendingOperations(): void;
  /** 取视口 (x,y) 处元素：生成稳定 CSS 选择器并返回其 bounds（标注模式用）。 */
  pickElement(x: number, y: number): Promise<PickElementResult>;
  /** 按选择器解析元素当前 bounds；元素不存在时返回 null（标注导航后重定位）。 */
  resolveSelectorBounds(selector: string): Promise<BrowserAnnotationBounds | null>;
  dispose(): void;
  onEvent(cb: (event: BrowserHostEvent) => void): () => void;
}

/** pickElement 结果：成功时含选择器与元素信息。 */
export type PickElementResult =
  | { ok: true; selector: string; bounds: BrowserAnnotationBounds; tag: string; name: string }
  | { ok: false; error: string };

/** 元素编号在最近一次 snapshot 后失效（页面导航/重绘）。 */
export class StaleReferenceError extends Error {
  constructor(message = "元素引用已失效，请重新获取页面快照") {
    super(message);
    this.name = "StaleReferenceError";
  }
}

const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SNAPSHOT_NODES = 200;
const AGENT_NAVIGATION_GUARD_WINDOW_MS = 5_000;
const HISTORY_NAVIGATION_TIMEOUT_MS = 30_000;
const NAME_MAX_CHARS = 120;

/** 可交互元素角色：这些节点会被编号供模型引用。 */
const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "switch"]);

/** CDP Accessibility.getFullAXTree 返回的节点子集。 */
export interface CdpAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { type?: string; value?: unknown } }>;
  boundingBox?: { x?: number; y?: number; width?: number; height?: number };
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** 交互元素 DOM 描述：标签、关键属性与稳定选择器（与标注拾取同算法）。 */
export interface InteractiveDomInfo {
  tag: string;
  attrs: BrowserSnapshotNode["attrs"];
  /** 页面内生成的稳定 CSS 选择器（模型可对照标注引用定位元素）。 */
  selector?: string;
}

export interface InteractiveElement {
  index: number;
  center: { x: number; y: number };
  backendDOMNodeId?: number;
  snapshotNode?: BrowserSnapshotNode;
  fingerprint?: Omit<BrowserActionTarget, "pageUrl">;
}

interface LiveTarget {
  tag: string;
  name: string;
  selector: string;
  attrs?: BrowserSnapshotNode["attrs"];
}

/** 基于 Electron webContents 原生 API + CDP 的宿主实现。 */
export class WebContentsHostController implements BrowserHostController {
  private readonly webContents: WebContents;
  private readonly listeners: Array<() => void> = [];
  private readonly eventListeners = new Set<(event: BrowserHostEvent) => void>();
  private cdpTimeoutMs: number;
  private maxSnapshotNodes: number;
  private readonly onAgentNavigation?: AgentNavigationGuard;
  private readonly onPopup?: (url: string) => void;
  /** 命令串行队列：同一 tab 内 CDP 命令逐个执行。 */
  private cdpQueue: Promise<void> = Promise.resolve();
  private debuggerAttached = false;
  private domDomainEnabled = false;
  private operationGeneration = 0;
  private agentNavigationGuard: { approvedUrl?: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 最近一次 snapshot 的可交互元素编号 → 中心坐标。 */
  private interactiveByIndex = new Map<number, InteractiveElement>();

  constructor(webContents: WebContents, options: WebContentsHostControllerOptions = {}) {
    this.webContents = webContents;
    this.cdpTimeoutMs = options.cdpTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    this.maxSnapshotNodes = options.maxSnapshotNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
    this.onAgentNavigation = options.onAgentNavigation;
    this.onPopup = options.onPopup;
    this.bindEvents();
    this.bindWindowOpenHandler();
  }

  async navigate(url: string, options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    if (options.agent) this.beginAgentNavigationGuard(options.navigationApprovalUrl);
    try {
      await this.webContents.loadURL(url);
    } catch (error) {
      if (options.agent) this.clearAgentNavigationGuard();
      throw error;
    }
  }

  getNavigationState(): BrowserNavigationState {
    const history = this.webContents.navigationHistory;
    return {
      activeIndex: history.getActiveIndex(),
      entries: history.getAllEntries().map((entry) => ({ url: entry.url, title: entry.title })),
    };
  }

  goBack(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.navigationHistory.goBack(), options);
  }

  goForward(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.navigationHistory.goForward(), options);
  }

  reload(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.reload(), options);
  }

  private runHistoryNavigation(
    start: () => void,
    options: { agent?: boolean; navigationApprovalUrl?: string },
  ): Promise<void> {
    if (options.agent) this.beginAgentNavigationGuard(options.navigationApprovalUrl);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onNavigate = (): void => finish();
      const onNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
        if (isMainFrame) finish();
      };
      const onFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ): void => {
        if (!isMainFrame || errorCode === -3) return;
        finish(new Error(`导航失败（${errorCode}）：${errorDescription}`));
      };
      const timer = setTimeout(
        () => finish(new Error(`历史导航超时（${HISTORY_NAVIGATION_TIMEOUT_MS}ms）`)),
        HISTORY_NAVIGATION_TIMEOUT_MS,
      );
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.webContents.removeListener("did-navigate", onNavigate);
        this.webContents.removeListener("did-navigate-in-page", onNavigateInPage);
        this.webContents.removeListener("did-fail-load", onFailLoad);
        if (options.agent && error) this.clearAgentNavigationGuard();
        if (error) reject(error);
        else resolve();
      };
      this.webContents.once("did-navigate", onNavigate);
      this.webContents.once("did-navigate-in-page", onNavigateInPage);
      this.webContents.on("did-fail-load", onFailLoad);
      try {
        start();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async captureScreenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    const image: NativeImage = await this.webContents.capturePage();
    if (image.isEmpty()) throw new Error("页面截图失败：图像为空");
    const size = image.getSize();
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
  }

  /** 结构化页面快照：AX 树简化 + 可交互元素编号 + 可选截图。 */
  async snapshot(opts: { withScreenshot: boolean }): Promise<BrowserSnapshot> {
    const [tree, viewport, screenshot] = await Promise.all([
      this.runCdp(() => this.buildSnapshotTree()),
      this.runCdp(() => this.evaluateViewport()),
      opts.withScreenshot ? this.runCdp(() => this.captureCdpScreenshot()) : Promise.resolve(null),
    ]);
    return {
      url: this.webContents.getURL(),
      title: this.webContents.getTitle(),
      timestamp: Date.now(),
      viewport,
      tree,
      screenshot,
    };
  }

  /** 元素级交互（click/type/scroll），编号来自最近一次 snapshot。 */
  async performAction(
    action: BrowserAction,
    options: { agent?: boolean } = {},
  ): Promise<{ url?: string; title?: string }> {
    return this.runCdp(async () => {
      if (options.agent)
        this.beginAgentNavigationGuard(action.type === "click" ? action.navigationApprovalUrl : undefined);
      try {
        switch (action.type) {
          case "click":
            await this.clickElement(action.elementIndex, action.target);
            break;
          case "type":
            await this.typeText(action.elementIndex, action.text, action.submit === true, action.target);
            break;
          case "scroll":
            await this.scrollPage(action.direction, action.amount);
            break;
          default:
            throw new Error(`未知浏览器操作类型: ${String((action as { type?: unknown }).type)}`);
        }
        return {
          url: this.webContents.getURL() || undefined,
          title: this.webContents.getTitle() || undefined,
        };
      } finally {
        // 任何页面动作都使旧编号失效；事件导航也会清空，但 DOM 重排不一定触发导航。
        this.interactiveByIndex.clear();
        if (options.agent) this.scheduleAgentNavigationGuardClear();
      }
    });
  }

  inspectElement(elementIndex: number): BrowserSnapshotNode | null {
    const element = this.interactiveByIndex.get(elementIndex);
    if (!element?.snapshotNode) return null;
    return {
      ...element.snapshotNode,
      ...(element.snapshotNode.attrs ? { attrs: { ...element.snapshotNode.attrs } } : {}),
    };
  }

  clearData(): Promise<void> {
    return this.webContents.session.clearStorageData();
  }

  updateSettings(options: { cdpTimeoutMs: number; maxSnapshotNodes: number }): void {
    this.cdpTimeoutMs = options.cdpTimeoutMs;
    this.maxSnapshotNodes = options.maxSnapshotNodes;
    this.interactiveByIndex.clear();
  }

  /** 取消当前 CDP/导航操作，并让迟到的命令结果失效。 */
  cancelPendingOperations(): void {
    this.operationGeneration += 1;
    this.interactiveByIndex.clear();
    this.clearAgentNavigationGuard();
    try {
      this.webContents.stop();
    } catch {
      // guest 已销毁或尚未 attach 时停止可能失败。
    }
    this.detachDebugger();
  }

  /** 取视口坐标处元素（标注模式）：经 Runtime.evaluate 在页面内生成稳定选择器。 */
  async pickElement(x: number, y: number): Promise<PickElementResult> {
    return this.runCdp(() => this.pickElementInternal(x, y));
  }

  private async pickElementInternal(x: number, y: number): Promise<PickElementResult> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression: PICK_ELEMENT_SCRIPT.replace("__X__", String(x)).replace("__Y__", String(y)),
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = response.result?.value as
      | { error?: string; selector?: string; bounds?: BrowserAnnotationBounds; tag?: string; name?: string }
      | undefined;
    if (!value || typeof value !== "object") return { ok: false, error: "无法解析页面元素" };
    if (value.error !== undefined) return { ok: false, error: value.error };
    if (typeof value.selector !== "string" || !value.bounds) return { ok: false, error: "元素选择器生成失败" };
    return {
      ok: true,
      selector: value.selector,
      bounds: value.bounds,
      tag: value.tag ?? "",
      name: value.name ?? "",
    };
  }

  /** 按选择器解析元素当前 bounds（导航后标注重定位）；不存在返回 null。 */
  async resolveSelectorBounds(selector: string): Promise<BrowserAnnotationBounds | null> {
    return this.runCdp(() => this.resolveSelectorBoundsInternal(selector));
  }

  private async resolveSelectorBoundsInternal(selector: string): Promise<BrowserAnnotationBounds | null> {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`;
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = response.result?.value as
      | { x?: number; y?: number; width?: number; height?: number }
      | null
      | undefined;
    if (!value || typeof value !== "object") return null;
    if (
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      typeof value.height !== "number"
    ) {
      return null;
    }
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }

  dispose(): void {
    this.cancelPendingOperations();
    for (const remove of this.listeners.splice(0)) remove();
    this.eventListeners.clear();
    this.interactiveByIndex.clear();
    this.detachDebugger();
  }

  onEvent(cb: (event: BrowserHostEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** 把操作排入串行队列并带超时执行；超时会取消当前代次。 */
  private runCdp<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.operationGeneration;
    let underlying: Promise<T> | undefined;
    const start = () => {
      if (generation !== this.operationGeneration) return Promise.reject(new Error("CDP 操作已取消"));
      underlying = Promise.resolve().then(operation);
      return withTimeout(underlying, this.cdpTimeoutMs, () => this.cancelPendingOperations());
    };
    const run = this.cdpQueue.then(start, start);
    // 超时只让调用方尽快得到错误；队列仍等待底层 sendCommand 结束，避免
    // detach 后迟到的旧命令与新一代命令并发使用同一个 debugger transport。
    this.cdpQueue = run.then(
      () =>
        underlying?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
      () =>
        underlying?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
    );
    return run;
  }

  private ensureDebugger(): void {
    if (this.debuggerAttached) return;
    try {
      this.webContents.debugger.attach("1.3");
      this.debuggerAttached = true;
      this.webContents.debugger.once("detach", () => {
        this.debuggerAttached = false;
        this.domDomainEnabled = false;
      });
    } catch (error) {
      this.debuggerAttached = false;
      this.domDomainEnabled = false;
      throw new Error(`CDP attach 失败: ${messageOf(error)}`);
    }
  }

  private detachDebugger(): void {
    if (!this.debuggerAttached) return;
    try {
      this.webContents.debugger.detach();
    } catch {
      // guest 已销毁等场景下 detach 失败可忽略。
    }
    this.debuggerAttached = false;
    this.domDomainEnabled = false;
  }

  private async sendCommand(method: string, params?: unknown): Promise<unknown> {
    const generation = this.operationGeneration;
    this.ensureDebugger();
    if (!this.domDomainEnabled && method !== "DOM.enable") {
      await this.webContents.debugger.sendCommand("DOM.enable", {});
      if (generation !== this.operationGeneration) throw new Error("CDP 操作已取消");
      this.domDomainEnabled = true;
    }
    const result = await this.webContents.debugger.sendCommand(method, params as Record<string, unknown>);
    if (generation !== this.operationGeneration) throw new Error("CDP 操作已取消");
    return result;
  }

  private async buildSnapshotTree(): Promise<BrowserSnapshotNode[]> {
    const viewport = await this.evaluateViewport();
    const response = (await this.sendCommand("Accessibility.getFullAXTree")) as { nodes?: CdpAxNode[] };
    const nodes = response.nodes ?? [];
    if (nodes.length === 0) return [];

    const byId = new Map<string, CdpAxNode>();
    const referenced = new Set<string>();
    const interactiveNodes = collectInteractive(nodes, viewport);
    const boundsByNodeId = await this.resolveInteractiveBounds(interactiveNodes);
    const normalizedNodes = nodes.map((node) => {
      const bounds = node.nodeId ? boundsByNodeId.get(node.nodeId) : undefined;
      return bounds ? { ...node, boundingBox: bounds } : node;
    });
    for (const node of normalizedNodes) {
      if (node.nodeId) byId.set(node.nodeId, node);
    }
    for (const node of normalizedNodes) {
      for (const childId of node.childIds ?? []) referenced.add(childId);
    }
    const roots = normalizedNodes.filter((node) => node.nodeId && !referenced.has(node.nodeId));

    // 可交互节点的 DOM 信息（标签/属性）批量获取一次。
    const domByNodeId = await this.describeInteractiveDom(collectInteractive(normalizedNodes, viewport));

    // 重建可交互索引：本轮快照覆盖旧索引，交互动作以最新快照为准。
    this.interactiveByIndex = new Map();
    const counter = { value: 0 };
    const budget = { value: this.maxSnapshotNodes };
    const built = roots
      .map((node) => buildNode(node, byId, domByNodeId, counter, this.interactiveByIndex, budget, viewport))
      .filter((node): node is BrowserSnapshotNode => node !== null);
    return built;
  }

  private async resolveInteractiveBounds(
    nodes: CdpAxNode[],
  ): Promise<Map<string, { x: number; y: number; width: number; height: number }>> {
    const result = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const node of nodes) {
      if (!node.nodeId) continue;
      const existing = node.boundingBox;
      if (
        existing &&
        typeof existing.x === "number" &&
        typeof existing.y === "number" &&
        typeof existing.width === "number" &&
        typeof existing.height === "number"
      ) {
        result.set(node.nodeId, {
          x: existing.x,
          y: existing.y,
          width: existing.width,
          height: existing.height,
        });
        continue;
      }
      if (node.backendDOMNodeId === undefined) continue;
      try {
        const response = (await this.sendCommand("DOM.getBoxModel", {
          backendNodeId: node.backendDOMNodeId,
        })) as { model?: { content?: number[] } };
        const bounds = boundsFromContent(response.model?.content);
        if (bounds) result.set(node.nodeId, bounds);
      } catch {
        // 元素没有布局盒或页面正在重排时不编号，避免返回不可点击的引用。
      }
    }
    return result;
  }

  private async describeInteractiveDom(nodes: CdpAxNode[]): Promise<Map<string, InteractiveDomInfo>> {
    const result = new Map<string, InteractiveDomInfo>();
    for (const node of nodes) {
      const backendId = node.backendDOMNodeId;
      if (backendId === undefined) continue;
      try {
        const dom = (await this.sendCommand("DOM.describeNode", {
          backendNodeId: backendId,
        })) as { node?: { nodeName?: string; attributes?: string[] } };
        const nodeName = (dom.node?.nodeName ?? "").toLowerCase();
        const attributes = dom.node?.attributes ?? [];
        const attrs: NonNullable<BrowserSnapshotNode["attrs"]> = {};
        for (let index = 0; index + 1 < attributes.length; index += 2) {
          const key = attributes[index];
          const value = attributes[index + 1];
          if (key === "href" && value) attrs.href = value;
          if (key === "type" && value) attrs.type = value;
          if (key === "formaction" && value) attrs.formAction = value;
          if (key === "formmethod" && value) attrs.formMethod = value;
          if (key === "name" && value) attrs.name = value;
        }
        const axProps = propsMap(node);
        const urlValue = axProps.get("url");
        if (urlValue !== undefined) attrs.href = String(urlValue);
        const checked = asBoolean(axProps.get("checked"));
        if (checked !== undefined) attrs.checked = checked;
        const selected = asBoolean(axProps.get("selected"));
        if (selected !== undefined) attrs.selected = selected;
        // 生成与标注拾取同算法的稳定选择器（供模型对照标注引用）。
        const nodeId = node.nodeId;
        if (!nodeId) continue;
        const selector = await this.resolveElementSelector(backendId);
        result.set(nodeId, { tag: nodeName, attrs, selector });
      } catch {
        // DOM 描述失败不影响树主体。
      }
    }
    return result;
  }

  /** 经 DOM.resolveNode + callFunctionOn 在页面内生成元素选择器（与 PICK_ELEMENT_SCRIPT 同算法）。 */
  private async resolveElementSelector(backendNodeId: number): Promise<string | undefined> {
    try {
      const resolved = (await this.sendCommand("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = resolved.object?.objectId;
      if (!objectId) return undefined;
      const evaluated = (await this.sendCommand("Runtime.callFunctionOn", {
        functionDeclaration: SELECTOR_FROM_ELEMENT_FN,
        objectId,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const value = evaluated.result?.value;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async evaluateViewport(): Promise<BrowserSnapshot["viewport"]> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
      returnByValue: true,
    })) as { result?: { value?: { width?: number; height?: number; dpr?: number } } };
    const value = response.result?.value;
    return {
      width: typeof value?.width === "number" ? value.width : 0,
      height: typeof value?.height === "number" ? value.height : 0,
      dpr: typeof value?.dpr === "number" ? value.dpr : 1,
    };
  }

  private async captureCdpScreenshot(): Promise<string> {
    const response = (await this.sendCommand("Page.captureScreenshot", { format: "png" })) as {
      data?: string;
    };
    if (typeof response.data !== "string" || response.data.length === 0) {
      throw new Error("CDP 截图失败：返回空数据");
    }
    return `data:image/png;base64,${response.data}`;
  }

  private async clickElement(elementIndex: number, target?: BrowserActionTarget): Promise<void> {
    const element = await this.resolveInteractive(elementIndex, target);
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: element.center.x,
      y: element.center.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: element.center.x,
      y: element.center.y,
      button: "left",
      clickCount: 1,
    });
  }

  private async typeText(
    elementIndex: number,
    text: string,
    submit: boolean,
    target?: BrowserActionTarget,
  ): Promise<void> {
    await this.clickElement(elementIndex, target);
    await this.sendCommand("Input.insertText", { text });
    if (submit) {
      const enter = {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };
      await this.sendCommand("Input.dispatchKeyEvent", enter);
      await this.sendCommand("Input.dispatchKeyEvent", { ...enter, type: "keyUp" });
    }
  }

  private async scrollPage(direction: "up" | "down" | "top" | "bottom", amount?: number): Promise<void> {
    if (direction === "top" || direction === "bottom") {
      const expression =
        direction === "top"
          ? "window.scrollTo(0, 0)"
          : "window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))";
      await this.sendCommand("Runtime.evaluate", { expression });
      this.interactiveByIndex.clear();
      return;
    }
    const delta = (direction === "up" ? -1 : 1) * (typeof amount === "number" && amount > 0 ? amount : 400);
    await this.sendCommand("Runtime.evaluate", {
      expression: `window.scrollBy(0, ${delta})`,
    });
    this.interactiveByIndex.clear();
  }

  private async resolveInteractive(elementIndex: number, expected?: BrowserActionTarget): Promise<InteractiveElement> {
    if (expected && canonicalUrl(this.webContents.getURL()) !== canonicalUrl(expected.pageUrl)) {
      throw new StaleReferenceError();
    }
    const element = this.interactiveByIndex.get(elementIndex);
    if (!element) throw new StaleReferenceError();
    if (expected && !matchesStoredTarget(element.fingerprint, expected)) throw new StaleReferenceError();
    if (element.backendDOMNodeId === undefined) {
      if (expected) throw new StaleReferenceError();
      return element;
    }

    try {
      const response = (await this.sendCommand("DOM.getBoxModel", {
        backendNodeId: element.backendDOMNodeId,
      })) as { model?: { content?: number[] } };
      const content = response.model?.content;
      if (!content || content.length < 8 || content.some((value) => !Number.isFinite(value))) {
        throw new Error("元素 bounds 不可用");
      }
      if (expected) {
        const live = await this.readLiveTarget(element.backendDOMNodeId);
        if (!live || !matchesLiveTarget(live, expected)) throw new StaleReferenceError();
      }
      const xs = [content[0]!, content[2]!, content[4]!, content[6]!];
      const ys = [content[1]!, content[3]!, content[5]!, content[7]!];
      const next = {
        ...element,
        center: {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        },
      };
      this.interactiveByIndex.set(elementIndex, next);
      return next;
    } catch (error) {
      if (error instanceof StaleReferenceError) throw error;
      throw new StaleReferenceError();
    }
  }

  private async readLiveTarget(backendDOMNodeId: number): Promise<LiveTarget | null> {
    const resolved = (await this.sendCommand("DOM.resolveNode", { backendNodeId: backendDOMNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return null;
    const evaluated = (await this.sendCommand("Runtime.callFunctionOn", {
      functionDeclaration: LIVE_TARGET_METADATA_FN,
      objectId,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = evaluated.result?.value;
    return isLiveTarget(value) ? value : null;
  }

  private beginAgentNavigationGuard(approvedUrl?: string): void {
    if (!this.onAgentNavigation) return;
    if (this.agentNavigationGuard) clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard = {
      ...(approvedUrl !== undefined ? { approvedUrl } : {}),
      timer: setTimeout(() => this.clearAgentNavigationGuard(), AGENT_NAVIGATION_GUARD_WINDOW_MS),
    };
  }

  private scheduleAgentNavigationGuardClear(): void {
    if (!this.agentNavigationGuard) return;
    clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard.timer = setTimeout(
      () => this.clearAgentNavigationGuard(),
      AGENT_NAVIGATION_GUARD_WINDOW_MS,
    );
  }

  private clearAgentNavigationGuard(): void {
    if (!this.agentNavigationGuard) return;
    clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard = null;
  }

  private bindWindowOpenHandler(): void {
    const setWindowOpenHandler = this.webContents.setWindowOpenHandler;
    if (typeof setWindowOpenHandler !== "function") return;
    const handler = (details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
      if (isHttpUrl(details.url)) this.onPopup?.(details.url);
      return { action: "deny" };
    };
    try {
      setWindowOpenHandler.call(this.webContents, handler);
      this.listeners.push(() => {
        try {
          this.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        } catch {
          // guest 已销毁时无需再替换 handler。
        }
      });
    } catch {
      // guest 在 attach/teardown 竞态中可能不接受 window-open handler。
    }
  }

  private bindEvents(): void {
    const wc = this.webContents;

    const guardNavigation = (event: Electron.Event, url: string): void => {
      const guard = this.agentNavigationGuard;
      if (!guard || !this.onAgentNavigation) return;
      if (!this.onAgentNavigation(url, this.webContents.getURL(), guard.approvedUrl)) {
        // will-navigate/will-redirect 都是 URL 改变前可阻止的主 frame 导航事件。
        event.preventDefault();
      }
    };
    const onWillNavigate = (event: Electron.Event, url: string): void => {
      guardNavigation(event, url);
    };
    const onWillRedirect = (event: Electron.Event, url: string): void => {
      guardNavigation(event, url);
    };
    wc.on("will-navigate", onWillNavigate);
    wc.on("will-redirect", onWillRedirect);
    this.listeners.push(() => {
      wc.off("will-navigate", onWillNavigate);
      wc.off("will-redirect", onWillRedirect);
    });

    const onNavigated = (_event: Electron.Event, url: string): void => {
      const history = wc.navigationHistory;
      if (this.agentNavigationGuard) this.scheduleAgentNavigationGuardClear();
      this.interactiveByIndex.clear();
      this.emit({
        type: "navigated",
        url,
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      });
    };
    wc.on("did-navigate", onNavigated);
    this.listeners.push(() => {
      wc.off("did-navigate", onNavigated);
    });

    const onNavigatedInPage = (_event: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return;
      if (this.agentNavigationGuard) this.scheduleAgentNavigationGuardClear();
      this.interactiveByIndex.clear();
      this.emit({ type: "navigated-in-page", url });
    };
    wc.on("did-navigate-in-page", onNavigatedInPage);
    this.listeners.push(() => {
      wc.off("did-navigate-in-page", onNavigatedInPage);
    });

    const onTitleUpdated = (_event: Electron.Event, title: string): void => {
      this.emit({ type: "title-updated", title });
    };
    wc.on("page-title-updated", onTitleUpdated);
    this.listeners.push(() => {
      wc.off("page-title-updated", onTitleUpdated);
    });

    const onStartLoading = (): void => {
      this.interactiveByIndex.clear();
      this.emit({ type: "loading-changed", loading: true });
    };
    wc.on("did-start-loading", onStartLoading);
    this.listeners.push(() => {
      wc.off("did-start-loading", onStartLoading);
    });

    const onStopLoading = (): void => {
      this.emit({ type: "loading-changed", loading: false });
    };
    wc.on("did-stop-loading", onStopLoading);
    this.listeners.push(() => {
      wc.off("did-stop-loading", onStopLoading);
    });

    // 加载失败（DNS/连接/证书等网络错误）：-3 (ERR_ABORTED) 是用户停止或
    // 被新导航取代，不算失败；其余错误上报给 UI 展示。
    const onDidFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return;
      this.clearAgentNavigationGuard();
      if (errorCode === -3) return;
      this.emit({
        type: "load-failed",
        url: validatedURL,
        code: errorCode,
        description: errorDescription,
      });
    };
    wc.on("did-fail-load", onDidFailLoad);
    this.listeners.push(() => {
      wc.off("did-fail-load", onDidFailLoad);
    });

    const onRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      this.emit({ type: "crashed", reason: details.reason });
    };
    wc.on("render-process-gone", onRenderProcessGone);
    this.listeners.push(() => {
      wc.off("render-process-gone", onRenderProcessGone);
    });

    const onDestroyed = (): void => {
      this.emit({ type: "destroyed" });
    };
    wc.on("destroyed", onDestroyed);
    this.listeners.push(() => {
      wc.off("destroyed", onDestroyed);
    });
  }

  private emit(event: BrowserHostEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }
}

/** 收集可交互且可见的节点（供 DOM 描述与编号）。viewport 提供时，中心点不在
 *  视口内的元素视为不可见（离屏元素点击坐标不可达）。 */
export function collectInteractive(nodes: CdpAxNode[], viewport?: { width: number; height: number }): CdpAxNode[] {
  const interactive: CdpAxNode[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value ?? "";
    if (INTERACTIVE_ROLES.has(role) && (isVisible(node, viewport) || node.backendDOMNodeId !== undefined))
      interactive.push(node);
  }
  return interactive;
}

function boundsFromContent(
  content: number[] | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!content || content.length < 8 || content.some((value) => !Number.isFinite(value))) return null;
  const xs = [content[0]!, content[2]!, content[4]!, content[6]!];
  const ys = [content[1]!, content[3]!, content[5]!, content[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function isVisible(node: CdpAxNode, viewport?: { width: number; height: number }): boolean {
  const box = node.boundingBox;
  if (!box || box.width === undefined || box.height === undefined || box.width <= 0 || box.height <= 0) {
    return false;
  }
  // 无视口信息（单测/评估失败）时退化为仅尺寸检查。
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return true;
  const centerX = box.x !== undefined ? box.x + box.width / 2 : NaN;
  const centerY = box.y !== undefined ? box.y + box.height / 2 : NaN;
  return centerX >= 0 && centerX <= viewport.width && centerY >= 0 && centerY <= viewport.height;
}

/** 纯函数（导出供测试）：构建简化树。budget 为剩余节点配额（0 时停止输出）。
 *  viewport 提供时过滤中心点不在视口内的元素。 */
export function buildNode(
  node: CdpAxNode,
  byId: Map<string, CdpAxNode>,
  domByNodeId: Map<string, InteractiveDomInfo>,
  counter: { value: number },
  interactiveByIndex: Map<number, InteractiveElement>,
  budget: { value: number },
  viewport?: { width: number; height: number },
): BrowserSnapshotNode | null {
  if (node.ignored) {
    // ignored 节点自身不输出，但继续输出其子节点。
    return collapseChildren(node, byId, domByNodeId, counter, interactiveByIndex, budget, viewport);
  }
  if (budget.value <= 0) return null;
  budget.value -= 1;
  const role = node.role?.value ?? "generic";
  const interactive = INTERACTIVE_ROLES.has(role) && isVisible(node, viewport);
  const dom = node.nodeId ? domByNodeId.get(node.nodeId) : undefined;
  const nodeId = node.nodeId;
  const built: BrowserSnapshotNode = {
    role,
    name: truncate(node.name?.value ?? "", NAME_MAX_CHARS),
    tag: dom?.tag ?? roleToTag(role),
  };
  const rawValue = node.value?.value;
  if (typeof rawValue === "string" && rawValue.length > 0) {
    built.value = truncate(rawValue, NAME_MAX_CHARS);
  }
  const attrs = dom?.attrs;
  if (attrs && Object.keys(attrs).length > 0) built.attrs = attrs;
  if (interactive && dom?.selector) built.selector = dom.selector;
  const box = node.boundingBox;
  if (
    interactive &&
    box &&
    box.x !== undefined &&
    box.y !== undefined &&
    box.width !== undefined &&
    box.height !== undefined
  ) {
    const center = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
    counter.value += 1;
    built.index = counter.value;
    built.center = center;
    if (nodeId) {
      const interactiveElement: InteractiveElement = { index: counter.value, center };
      if (node.backendDOMNodeId !== undefined) {
        interactiveElement.backendDOMNodeId = node.backendDOMNodeId;
        interactiveElement.snapshotNode = built;
        interactiveElement.fingerprint = {
          role: built.role,
          tag: built.tag,
          name: built.name,
          ...(built.selector !== undefined ? { selector: built.selector } : {}),
          ...(built.attrs !== undefined ? { attrs: { ...built.attrs } } : {}),
        };
      }
      interactiveByIndex.set(counter.value, interactiveElement);
    }
  }
  const children = (node.childIds ?? [])
    .map((childId) => {
      const child = byId.get(childId);
      return child ? buildNode(child, byId, domByNodeId, counter, interactiveByIndex, budget, viewport) : null;
    })
    .filter((child): child is BrowserSnapshotNode => child !== null);
  if (children.length > 0) built.children = children;
  return built;
}

/** ignored 节点的子节点直接上提（不引入中间层）。 */
export function collapseChildren(
  node: CdpAxNode,
  byId: Map<string, CdpAxNode>,
  domByNodeId: Map<string, InteractiveDomInfo>,
  counter: { value: number },
  interactiveByIndex: Map<number, InteractiveElement>,
  budget: { value: number },
  viewport?: { width: number; height: number },
): BrowserSnapshotNode | null {
  const children = (node.childIds ?? [])
    .map((childId) => {
      const child = byId.get(childId);
      return child ? buildNode(child, byId, domByNodeId, counter, interactiveByIndex, budget, viewport) : null;
    })
    .filter((child): child is BrowserSnapshotNode => child !== null);
  if (children.length === 0) return null;
  // 多个子节点时合并为 generic 容器；单子节点直接提升。
  if (children.length === 1) return children[0];
  return { role: "generic", name: "", tag: "generic", children };
}

function propsMap(node: CdpAxNode): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const property of node.properties ?? []) {
    if (property.name && property.value?.value !== undefined) {
      map.set(property.name, property.value.value);
    }
  }
  return map;
}

/** CDP 属性值转布尔：boolean 直取；"true"/"false" 字符串解析；其余（含 "mixed"）视为未定义。 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const roleToTagMap: Record<string, string> = {
  button: "button",
  link: "a",
  textbox: "input",
  combobox: "select",
  checkbox: "input",
  radio: "input",
  menuitem: "li",
  switch: "button",
};

function roleToTag(role: string): string {
  return roleToTagMap[role] ?? role;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`CDP 命令超时（${timeoutMs}ms）`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

function matchesStoredTarget(
  fingerprint: Omit<BrowserActionTarget, "pageUrl"> | undefined,
  expected: BrowserActionTarget,
): boolean {
  if (!fingerprint) return false;
  return (
    fingerprint.role === expected.role &&
    fingerprint.tag === expected.tag &&
    fingerprint.name === expected.name &&
    (fingerprint.selector ?? "") === (expected.selector ?? "") &&
    matchesAttrs(fingerprint.attrs, expected.attrs)
  );
}

function matchesLiveTarget(live: LiveTarget, expected: BrowserActionTarget): boolean {
  return (
    live.tag === expected.tag &&
    (live.name.length === 0 || expected.name.length === 0 || live.name === expected.name) &&
    (live.selector ?? "") === (expected.selector ?? "") &&
    matchesAttrs(live.attrs, expected.attrs)
  );
}

function matchesAttrs(
  actual: BrowserSnapshotNode["attrs"] | undefined,
  expected: BrowserSnapshotNode["attrs"] | undefined,
): boolean {
  if (!expected) return true;
  const keys = ["href", "type", "checked", "selected", "formAction", "formMethod", "name"] as const;
  for (const key of keys) {
    if (expected[key] !== undefined && actual?.[key] !== expected[key]) return false;
  }
  return true;
}

function isLiveTarget(value: unknown): value is LiveTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tag === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.selector === "string" &&
    (candidate.attrs === undefined || typeof candidate.attrs === "object")
  );
}

/** 页面内执行的元素选择器生成函数（callFunctionOn：this 为 DOM 元素）。
 *  与 PICK_ELEMENT_SCRIPT 的选择器生成规则一致（id 优先 → tag+class → nth-child，至多 5 层）。 */
const SELECTOR_FROM_ELEMENT_FN = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length > 0) {
      part += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
      if (sameTag.length > 1) {
        part += ":nth-child(" + (Array.from(parent.children).indexOf(node) + 1) + ")";
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}`;

/** 页面内读取元素指纹；执行动作前用于检测确认后的 DOM 替换或属性篡改。 */
const LIVE_TARGET_METADATA_FN = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const attrs = {};
  if (typeof el.href === "string" && el.href.length > 0) attrs.href = el.href;
  for (const name of ["type", "formaction", "formmethod", "name"]) {
    const value = el.getAttribute(name);
    if (value) attrs[name === "formaction" ? "formAction" : name === "formmethod" ? "formMethod" : name] = value;
  }
  if (typeof el.checked === "boolean") attrs.checked = el.checked;
  if (typeof el.selected === "boolean") attrs.selected = el.selected;
  const labelledBy = el.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ? labelledBy
        .split(/s+/u)
        .map((id) => document.getElementById(id)?.innerText ?? "")
        .join(" ")
        .trim()
    : "";
  const labelText = el.labels?.[0]?.innerText?.trim() ?? "";
  const rawName = (
    el.getAttribute("aria-label") ||
    labelledText ||
    labelText ||
    el.innerText ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.getAttribute("name") ||
    ""
  ).trim();
  const name = rawName.length > 120 ? rawName.slice(0, 120) + "…" : rawName;
  return {
    tag: el.tagName.toLowerCase(),
    name,
    selector: (${SELECTOR_FROM_ELEMENT_FN}).call(el),
    attrs,
  };
}`;

/** 页面内执行的元素选取脚本：elementFromPoint + 稳定选择器生成（标注模式）。
 *  选取策略：空白区域（body/html）不可标注；优先提升到最近的可交互祖先
 *  （button/a/input 等，最多 4 层），hover 控件内部文本时高亮整个控件；
 *  提升结果超过视口 70% 时回退到原始元素（避免高亮超大容器）。
 *  生成规则：优先 id；其次 tag + 有限 class；同 tag 兄弟多时追加 nth-child；
 *  至多向上 5 层；返回选择器与视口 bounds。 */
const PICK_ELEMENT_SCRIPT = `(() => {
  const INTERACTIVE = "button, a, input, textarea, select, label, summary, [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio], [role=combobox], [role=menuitem], [role=switch], [tabindex], audio, video, iframe";
  const raw = document.elementFromPoint(__X__, __Y__);
  if (!raw || raw.nodeType !== 1) return { error: "点击位置没有可标注的元素" };
  const tag = raw.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return { error: "空白区域，没有可标注的元素" };
  let candidate = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (candidate.matches(INTERACTIVE)) break;
    const parent = candidate.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    candidate = parent;
  }
  const probe = candidate.getBoundingClientRect();
  if (probe.width > innerWidth * 0.7 || probe.height > innerHeight * 0.7) candidate = raw;
  const el = candidate;
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length > 0) {
      part += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
      if (sameTag.length > 1) {
        part += ":nth-child(" + (Array.from(parent.children).indexOf(node) + 1) + ")";
      }
    }
    parts.unshift(part);
    node = parent;
  }
  const r = el.getBoundingClientRect();
  return {
    selector: parts.join(" > "),
    bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    tag: el.tagName.toLowerCase(),
    name: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 120),
  };
})()`;
