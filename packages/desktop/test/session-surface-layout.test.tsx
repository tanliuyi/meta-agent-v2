import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampModalSize,
  clampOffset,
  clampPersistedGeometry,
  getDefaultModalSize,
  getDragOffset,
  getDragStep,
  getKeyboardDelta,
  getModalBasePosition,
  getResizeDragOffset,
  getResizeSize,
  isEligiblePointerDown,
  rebaseActiveDrag,
  rebaseActiveResize,
  SessionModal,
  sameModalGeometry,
} from "../src/renderer/src/components/session-modal.tsx";
import {
  resolveSessionInfoOpenForWorkbenchPanel,
  SessionSurface,
  setSessionModalGeometry,
  setSessionModalOpen,
  toggleSessionModalFullscreen,
} from "../src/renderer/src/components/session-surface.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";

const { chatThreadRenderCount } = vi.hoisted(() => ({ chatThreadRenderCount: { value: 0 } }));
const modalRoot = vi.hoisted(() => ({ onOpenChange: undefined as ((open: boolean) => void) | undefined }));
// 可变持久化状态：测试可注入已保存的 sessionModal（lazy 初始化/SSR 直接恢复）。
const sessionScope = vi.hoisted(() => ({
  scope: {
    record: { key: "session-1" },
    active: true,
    updateWorkbench: vi.fn(),
  },
  persisted: undefined as
    | undefined
    | {
        fullscreen: boolean;
        modalOpen: boolean;
        drag: { x: number; y: number };
        size: { width: number; height: number } | null;
      },
  panelOpen: false,
  // 会话级会话信息偏好（缺省 undefined = 默认展开）。
  sessionInfoOpen: undefined as boolean | undefined,
  // workbench store 是否已就绪（attach 完成）；false 时 selector 返回 null。
  ready: false,
}));

vi.mock("../src/renderer/src/components/chat/chat-thread.tsx", () => ({
  ChatThread: () => {
    chatThreadRenderCount.value += 1;
    return <div data-slot="messages" />;
  },
}));
vi.mock("../src/renderer/src/components/chat/session-info.tsx", () => ({
  SessionInfo: ({ open }: { open: boolean }) => <section data-slot="session-info" data-open={String(open)} />,
}));
vi.mock("../src/renderer/src/components/layout/topbar.tsx", () => ({
  Topbar: () => <header data-slot="topbar" />,
}));
vi.mock("../src/renderer/src/components/panel/terminal/bottom-terminal.tsx", () => ({
  BottomTerminal: () => <section data-slot="bottom" />,
}));
vi.mock("../src/renderer/src/components/panel/workbench-panel.tsx", () => ({
  WorkbenchPanel: () => <aside data-slot="panel" />,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => sessionScope.scope,
  useSessionWorkbenchSelector: (selector: (workbench: unknown) => unknown) =>
    selector(
      sessionScope.ready
        ? {
            panelOpen: sessionScope.panelOpen,
            sessionModal: sessionScope.persisted,
            sessionInfoOpen: sessionScope.sessionInfoOpen,
          }
        : null,
    ),
}));
// 用结构替身替代真实 Radix Portal（SSR 下 portal 返回 null，无法断言内容）。
vi.mock("@assistant-ui/react", () => ({
  AssistantModalPrimitive: {
    Root: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      children?: React.ReactNode;
    }) => {
      modalRoot.onOpenChange = onOpenChange;
      return (
        <div data-modal-root data-open={String(open)}>
          {children}
        </div>
      );
    },
    Anchor: ({ children }: { children?: React.ReactNode }) => <div data-modal-anchor>{children}</div>,
    Trigger: ({ children }: { children?: React.ReactNode }) => (
      <button type="button" data-modal-trigger onClick={() => modalRoot.onOpenChange?.(true)}>
        {children}
      </button>
    ),
    Content: ({ avoidCollisions, children }: { avoidCollisions?: boolean; children?: React.ReactNode }) => (
      <div data-modal-content="true" data-avoid-collisions={String(avoidCollisions)}>
        {children}
      </div>
    ),
  },
}));

const renderFullscreen = () =>
  renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(SessionSurface, { initialFullscreen: true })),
  );

describe("SessionSurface layout", () => {
  beforeEach(() => {
    chatThreadRenderCount.value = 0;
    sessionScope.persisted = undefined;
    sessionScope.panelOpen = false;
    sessionScope.sessionInfoOpen = undefined;
    sessionScope.ready = false;
    sessionScope.scope.updateWorkbench.mockClear();
  });

  it("groups the topbar and session row before the terminal and workbench", () => {
    const markup = renderToStaticMarkup(React.createElement(SessionSurface));

    expect(markup).toContain(
      '<div class="session-surface-shell"><header data-slot="topbar"></header><div class="workspace-row session-surface" data-session-key="session-1" data-active="true"><main class="chat-workspace" data-session-info-open="true"><div data-slot="messages"></div><section data-slot="session-info" data-open="true"></section></main></div></div><section data-slot="bottom"></section><aside data-slot="panel"></aside>',
    );
    // 普通态：ChatThread 唯一实例，不渲染 modal。
    expect(chatThreadRenderCount.value).toBe(1);
    expect(markup).not.toContain("data-modal-root");
  });

  it("collapses session info only while the current session workbench panel is open", () => {
    expect(resolveSessionInfoOpenForWorkbenchPanel(true, true)).toBe(false);
    expect(resolveSessionInfoOpenForWorkbenchPanel(true, false)).toBe(false);
    expect(resolveSessionInfoOpenForWorkbenchPanel(false, true)).toBe(true);
    expect(resolveSessionInfoOpenForWorkbenchPanel(false, false)).toBe(false);
  });

  it("keeps the workbench conflict out of the persisted per-session preference", () => {
    sessionScope.ready = true;
    sessionScope.sessionInfoOpen = true;

    // workbench 展开：面板派生隐藏，但偏好（以及持久化写回）保持不动。
    sessionScope.panelOpen = true;
    let markup = renderToStaticMarkup(React.createElement(SessionSurface));
    expect(markup).toContain('data-open="false"');

    // workbench 关闭：按偏好自动恢复显示。
    sessionScope.panelOpen = false;
    markup = renderToStaticMarkup(React.createElement(SessionSurface));
    expect(markup).toContain('data-open="true"');
    expect(markup).toContain('data-session-info-open="true"');

    // 冲突只是派生可见性：任何渲染都不写回偏好。
    expect(sessionScope.scope.updateWorkbench).not.toHaveBeenCalled();
  });

  it("keeps session info state isolated per session", () => {
    sessionScope.ready = true;

    // 会话 A：偏好关闭 + workbench 展开。
    sessionScope.sessionInfoOpen = false;
    sessionScope.panelOpen = true;
    const sessionAMarkup = renderToStaticMarkup(React.createElement(SessionSurface));

    // 会话 B：偏好展开。A 的 workbench 冲突不得影响 B。
    sessionScope.sessionInfoOpen = true;
    sessionScope.panelOpen = false;
    const sessionBMarkup = renderToStaticMarkup(React.createElement(SessionSurface));

    expect(sessionAMarkup).toContain('data-open="false"');
    expect(sessionBMarkup).toContain('data-open="true"');
    expect(sessionBMarkup).toContain('data-session-info-open="true"');
    expect(sessionScope.scope.updateWorkbench).not.toHaveBeenCalled();
  });

  it("renders the session thread inside the assistant modal when fullscreen", () => {
    const markup = renderFullscreen();

    // 普通会话壳让位，ChatThread 移入 modal Content 且仍为单实例。
    expect(markup).not.toContain('class="chat-workspace"');
    expect(markup).toContain("data-modal-anchor");
    expect(markup).toContain("data-modal-trigger");
    expect(markup).toContain('data-modal-content="true" data-avoid-collisions="false"');
    // Content 内是面板壳：拖拽条在上，thread 在 body 中。
    expect(markup).toContain(
      '<div data-modal-content="true" data-avoid-collisions="false"><div class="session-modal-shell"',
    );
    expect(markup).toContain('<div class="session-modal-body"><div data-slot="messages"></div></div>');
    expect(markup.match(/data-slot="messages"/g)).toHaveLength(1);
    expect(chatThreadRenderCount.value).toBe(1);
  });

  it("does not auto-open the modal when entering fullscreen", () => {
    const markup = renderFullscreen();

    expect(markup).toContain("data-modal-root");
    expect(markup).toContain('data-open="false"');
  });

  it("renders the modal drag handle above the thread body", () => {
    const markup = renderFullscreen();

    const contentIndex = markup.indexOf('data-modal-content="true"');
    const shellIndex = markup.indexOf('class="session-modal-shell"');
    const handleIndex = markup.indexOf('aria-label="拖动会话窗口"');
    const bodyIndex = markup.indexOf('class="session-modal-body"');
    const threadIndex = markup.indexOf('<div data-slot="messages"></div>');
    // 拖拽条位于 modal Content 内、thread 之前；可聚焦分组语义，支持键盘方向键移动。
    expect(shellIndex).toBeGreaterThan(contentIndex);
    expect(handleIndex).toBeGreaterThan(shellIndex);
    expect(bodyIndex).toBeGreaterThan(handleIndex);
    expect(threadIndex).toBeGreaterThan(bodyIndex);
    expect(markup).toContain('class="session-modal-drag-handle"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup.slice(handleIndex)).toContain('class="lucide lucide-grip-horizontal size-4"');
  });

  it("renders the modal resize handle after the thread body", () => {
    const markup = renderFullscreen();

    const bodyIndex = markup.indexOf('class="session-modal-body"');
    const handleIndex = markup.indexOf('aria-label="调整会话窗口大小"');
    // 缩放手柄位于 shell 内 thread body 之后，带可访问名称与可聚焦语义。
    expect(handleIndex).toBeGreaterThan(bodyIndex);
    expect(markup).toContain('class="session-modal-resize-handle"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
  });

  it("positions the radix content as a zero-size anchor without collision avoidance", () => {
    const markup = renderFullscreen();

    // Content 显式 avoidCollisions=false：Radix 定位不依赖内容尺寸，
    // 与 CSS 0x0 锚点配合消除 ResizeObserver 时序依赖。
    expect(markup).toContain('data-modal-content="true" data-avoid-collisions="false"');
  });

  it("computes each resize move from the start without accumulating deltas", () => {
    const startSize = { width: 720, height: 560 };
    const startPointer = { x: 100, y: 200 };
    // 第一次 move +10px：尺寸 730x560。
    expect(getResizeSize(startSize, startPointer, { x: 110, y: 200 })).toEqual({ width: 730, height: 560 });
    // 第二次 move 共 +20px：仍相对原始起点为 740，而不是在 730 上再叠 10。
    expect(getResizeSize(startSize, startPointer, { x: 120, y: 200 })).toEqual({ width: 740, height: 560 });
    // 反方向拖动：缩小。
    expect(getResizeSize(startSize, startPointer, { x: 90, y: 180 })).toEqual({ width: 710, height: 540 });
  });

  it("compensates the drag offset for the top/end anchored resize", () => {
    const startDrag = { x: 0, y: 0 };
    const startSize = { width: 720, height: 560 };
    const startPointer = { x: 100, y: 200 };
    // Radix top/end 布局：尺寸增大 delta 时布局基准左移/上移 delta，
    // 拖拽偏移补偿 +delta 使面板视觉左上角保持固定。
    expect(getResizeDragOffset(startDrag, startSize, { width: 730, height: 560 })).toEqual({ x: 10, y: 0 });
    expect(getResizeDragOffset(startDrag, startSize, { width: 620, height: 480 })).toEqual({ x: -100, y: -80 });
    // 每次 move 都相对缩放起点计算，不重复累计：第二次 move 仍以起点尺寸为基准。
    const first = getResizeSize(startSize, startPointer, { x: 110, y: 200 });
    const second = getResizeSize(startSize, startPointer, { x: 120, y: 200 });
    expect(getResizeDragOffset(startDrag, startSize, first)).toEqual({ x: 10, y: 0 });
    expect(getResizeDragOffset(startDrag, startSize, second)).toEqual({ x: 20, y: 0 });
    // 起点已带拖拽偏移（面板之前被拖过）：补偿叠加在起点之上。
    expect(getResizeDragOffset({ x: 40, y: -8 }, startSize, { width: 730, height: 560 })).toEqual({ x: 50, y: -8 });
  });

  it("anchors the layout base to the viewport like the radix top/end placement", () => {
    // anchor fixed right/bottom 16px、trigger 40px、sideOffset 16px：
    // left = vw - 16 - width；top = vh - 16 - 40 - 16 - height。
    expect(getModalBasePosition(1024, 768, 720, 560)).toEqual({ left: 288, top: 136 });
    expect(getModalBasePosition(600, 400, 568, 368)).toEqual({ left: 16, top: -40 });
    // 未缩放时的默认尺寸与 CSS min() 表达式一致。
    expect(getDefaultModalSize(1024, 768)).toEqual({ width: 720, height: 560 });
    expect(getDefaultModalSize(600, 400)).toEqual({ width: 568, height: 368 });
  });

  it("clamps the modal size between the min size and the viewport bounds from the top-left", () => {
    // 初始右下布局：左上角 (288,192)，最大 720x560。
    expect(clampModalSize({ width: 900, height: 700 }, 1024, 768, 288, 192)).toEqual({ width: 720, height: 560 });
    expect(clampModalSize({ width: 400, height: 200 }, 1024, 768, 288, 192)).toEqual({ width: 400, height: 280 });
    // 视口缩小时最大尺寸由左上角到视口边缘决定。
    expect(clampModalSize({ width: 900, height: 700 }, 600, 400, 16, 16)).toEqual({ width: 568, height: 368 });
    // 极小视口：最小尺寸退让到视口允许范围，不退让为负。
    const tiny = clampModalSize({ width: 900, height: 700 }, 300, 200, 0, 0);
    expect(tiny.width).toBeGreaterThan(0);
    expect(tiny.height).toBeGreaterThan(0);
    expect(tiny.width).toBeLessThanOrEqual(300);
    expect(tiny.height).toBeLessThanOrEqual(200);
  });

  it("rebases an active resize session on window resize", () => {
    const active = {
      pointerId: 1,
      startSize: { width: 720, height: 560 },
      startDrag: { x: 0, y: 0 },
      startPointer: { x: 100, y: 200 },
      latestPointer: { x: 130, y: 220 },
      topLeft: { x: 288, y: 192 },
    };
    const rebased = rebaseActiveResize(active, { width: 568, height: 368 }, { x: 16, y: 16 }, { x: 30, y: 20 });
    expect(rebased.startSize).toEqual({ width: 568, height: 368 });
    expect(rebased.startDrag).toEqual({ x: 30, y: 20 });
    expect(rebased.startPointer).toEqual({ x: 130, y: 220 });
    expect(rebased.topLeft).toEqual({ x: 16, y: 16 });
    // 下一次 move +1px 只产生 1px 增量，而不是把 resize 前的位移再叠加一次。
    expect(getResizeSize(rebased.startSize, rebased.startPointer, { x: 131, y: 220 })).toEqual({
      width: 569,
      height: 368,
    });
    // 下一次 move 的拖拽补偿也基于重基准后的起点（30,20）+ 增量。
    expect(getResizeDragOffset(rebased.startDrag, rebased.startSize, { width: 569, height: 368 })).toEqual({
      x: 31,
      y: 20,
    });
  });

  it("clamps size then position when the viewport shrinks", () => {
    vi.stubGlobal("window", { innerWidth: 700, innerHeight: 500 });
    try {
      // 自定义尺寸先按新视口 clamp，再以新尺寸 clamp 位置。
      const size = clampModalSize({ width: 800, height: 600 }, 700, 500, 16, 16);
      expect(size).toEqual({ width: 668, height: 468 });
      expect(clampOffset(0, 0, 16, 16, size.width, size.height)).toEqual({ x: 0, y: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("computes each drag move from the drag start without accumulating deltas", () => {
    const startDrag = { x: 0, y: 0 };
    const startPointer = { x: 100, y: 200 };
    // 第一次 move +10px：偏移 10。
    expect(getDragOffset(startDrag, startPointer, { x: 110, y: 200 })).toEqual({ x: 10, y: 0 });
    // 第二次 move 共 +20px：仍相对原始起点为 20，而不是在 10 上再叠 10 变成 30。
    expect(getDragOffset(startDrag, startPointer, { x: 120, y: 200 })).toEqual({ x: 20, y: 0 });
    // 起点已带偏移（前一次拖拽的落点）：位移相对该起点计算。
    expect(getDragOffset({ x: 40, y: -8 }, { x: 300, y: 300 }, { x: 260, y: 340 })).toEqual({
      x: 0,
      y: 32,
    });
  });

  it("clamps the drag offset to the viewport margin", () => {
    // 初始右下布局（base 为 Radix 布局位置，不含 translate）。
    const baseLeft = 288; // 1024 - 720 - 16
    const baseTop = 192; // 768 - 560 - 16
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
    try {
      expect(clampOffset(-5000, 0, baseLeft, baseTop, 720, 560)).toEqual({ x: 16 - baseLeft, y: 0 });
      expect(clampOffset(5000, 5000, baseLeft, baseTop, 720, 560)).toEqual({ x: 0, y: 0 });
      expect(clampOffset(0, 0, baseLeft, baseTop, 720, 560)).toEqual({ x: 0, y: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-clamps the offset when the viewport shrinks", () => {
    // 视口缩小后 modal 尺寸由 CSS 收窄，布局位置贴近左/上 16px，偏移只能为 0。
    vi.stubGlobal("window", { innerWidth: 600, innerHeight: 400 });
    try {
      expect(clampOffset(50, 50, 16, 16, 568, 368)).toEqual({ x: 0, y: 0 });
      expect(clampOffset(-50, -50, 16, 16, 568, 368)).toEqual({ x: 0, y: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only starts a drag from the primary pointer with the left button", () => {
    expect(isEligiblePointerDown(0, true)).toBe(true);
    expect(isEligiblePointerDown(1, true)).toBe(false);
    expect(isEligiblePointerDown(0, false)).toBe(false);
  });

  it("rebases the active drag after a resize so the next move only adds the delta", () => {
    const active = {
      pointerId: 1,
      startDrag: { x: 0, y: 0 },
      startPointer: { x: 100, y: 200 },
      latestPointer: { x: 130, y: 220 },
      baseLeft: 288,
      baseTop: 192,
      width: 720,
      height: 560,
    };
    // resize 后 modal 被 clamp 到 (30,20)；布局基准由调用方按不含 translate 的
    // Radix 布局位置传入（rect - resize 前的旧 offset）。
    const rebased = rebaseActiveDrag(
      active,
      { x: 30, y: 20 },
      { baseLeft: 274, baseTop: 192, width: 720, height: 560 },
    );
    expect(rebased.startDrag).toEqual({ x: 30, y: 20 });
    expect(rebased.startPointer).toEqual({ x: 130, y: 220 });
    expect(rebased.baseLeft).toBe(274);
    expect(rebased.baseTop).toBe(192);
    expect(rebased.width).toBe(720);
    expect(rebased.height).toBe(560);
    // 下一次 move +1px 只产生 1px 位移，而不是把 resize 前的 30px 位移再叠加一次。
    expect(getDragOffset(rebased.startDrag, rebased.startPointer, { x: 131, y: 220 })).toEqual({ x: 31, y: 20 });
  });

  it("rebases the active drag bounds on resize even when the offset is unchanged", () => {
    const active = {
      pointerId: 1,
      startDrag: { x: 0, y: 0 },
      startPointer: { x: 100, y: 200 },
      latestPointer: { x: 100, y: 200 },
      baseLeft: 288,
      baseTop: 192,
      width: 720,
      height: 560,
    };
    // resize 后 offset 不变（next 等于当前 drag），但视口缩小导致边界变化。
    const rebased = rebaseActiveDrag(active, { x: 0, y: 0 }, { baseLeft: 16, baseTop: 16, width: 568, height: 368 });
    expect(rebased.startDrag).toEqual({ x: 0, y: 0 });
    expect(rebased.startPointer).toEqual({ x: 100, y: 200 });
    expect(rebased.baseLeft).toBe(16);
    expect(rebased.baseTop).toBe(16);
    expect(rebased.width).toBe(568);
    expect(rebased.height).toBe(368);
  });

  it("keeps the layout base captured before the new offset when re-clamping after resize", () => {
    // 复现 resize handler 的真实时序：rect 在 applyDrag 前读取，包含旧 offset。
    // 旧 drag=(50,20)，旧 rect.left=66 → 布局基准 baseLeft=66-50=16；
    // 视口缩小后 next 被 clamp 到 (0,0)，但 rebase 必须保留传入的布局基准 16，
    // 不能用旧 rect 与新 offset 推导（66-0=66 会污染后续 clamp）。
    const active = {
      pointerId: 1,
      startDrag: { x: 50, y: 20 },
      startPointer: { x: 100, y: 200 },
      latestPointer: { x: 130, y: 220 },
      baseLeft: 288,
      baseTop: 192,
      width: 720,
      height: 560,
    };
    const rebased = rebaseActiveDrag(active, { x: 0, y: 0 }, { baseLeft: 16, baseTop: 16, width: 568, height: 368 });
    expect(rebased.startDrag).toEqual({ x: 0, y: 0 });
    expect(rebased.baseLeft).toBe(16);
    expect(rebased.baseTop).toBe(16);
    // 下一次 pointermove +1px：基于正确基准 16 的 clamp 边界为 [0, 0]（视口 600x400、
    // modal 568x368），+1 归零仍合法；若基准被错误推导为 66，边界会变成 [-50, -50]，
    // offset 被污染为 -50，后续每次 move 都带 -50 的偏移。
    vi.stubGlobal("window", { innerWidth: 600, innerHeight: 400 });
    try {
      const offset = getDragOffset(rebased.startDrag, rebased.startPointer, { x: 131, y: 220 });
      expect(offset).toEqual({ x: 1, y: 0 });
      expect(clampOffset(offset.x, offset.y, rebased.baseLeft, rebased.baseTop, rebased.width, rebased.height)).toEqual(
        { x: 0, y: 0 },
      );
      // 对照：用 rect.left - next.x 的错误推导（66）会得到 [-50, -50] 的非法边界。
      expect(clampOffset(offset.x, offset.y, 66, 66, 568, 368)).toEqual({ x: -50, y: -50 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves by fine step with shift and normal step otherwise", () => {
    expect(getDragStep(false)).toBe(16);
    expect(getDragStep(true)).toBe(1);
    expect(getKeyboardDelta("ArrowRight", false)).toEqual({ x: 16, y: 0 });
    expect(getKeyboardDelta("ArrowUp", true)).toEqual({ x: 0, y: -1 });
    expect(getKeyboardDelta("Enter", false)).toBeNull();
  });

  it("keeps positive modal size in tiny viewports", () => {
    // 视口小于 2*MODAL_MARGIN 时退让值可能为负，必须保证返回正尺寸；
    // 视口为 0 时下限 1px 允许超过空视口（保护性下限）。
    for (const vw of [20, 0]) {
      for (const vh of [20, 0]) {
        const size = clampModalSize({ width: 900, height: 700 }, vw, vh, 0, 0);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeGreaterThanOrEqual(1);
        expect(size.width).toBeLessThanOrEqual(Math.max(vw, 1));
        expect(size.height).toBeLessThanOrEqual(Math.max(vh, 1));
        // 默认尺寸同样保持正（与 CSS max(1px, ...) 下限一致）。
        const def = getDefaultModalSize(vw, vh);
        expect(def.width).toBeGreaterThanOrEqual(1);
        expect(def.height).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps the panel size on the shell with a zero-size radix anchor", () => {
    const css = readFileSync(new URL("../src/renderer/src/styles/layout.css", import.meta.url), "utf8");
    // Content 是 0x0 定位锚点：不持有尺寸、不裁剪溢出内容，无透明命中面积。
    // position: relative 使其成为 shell 的 containing block（Radix 的
    // fixed/transform 定位在外层 wrapper，不能依赖 Content 默认定位）。
    const contentRule = css.match(/\.session-modal-content\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(contentRule).toContain("position: relative");
    expect(contentRule).toMatch(/width:\s*0/);
    expect(contentRule).toMatch(/height:\s*0/);
    expect(contentRule).toContain("overflow: visible");
    // 实际尺寸（CSS 默认 min() 表达式，1px 下限）由 shell 持有：绝对定位于
    // Content 锚点右下角，尺寸增长向左上展开。
    const shellRule = css.match(/\.session-modal-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(shellRule).toContain("position: absolute");
    expect(shellRule).toContain("right: 0");
    expect(shellRule).toContain("bottom: 0");
    expect(shellRule).toMatch(/width:\s*max\(1px,\s*min\(720px,\s*calc\(100vw - 32px\)\)\)/);
    expect(shellRule).toMatch(/height:\s*max\(1px,\s*min\(560px,\s*calc\(100vh - 32px\)\)\)/);
  });

  it("draws the resize handle arc inside the hot zone", () => {
    const css = readFileSync(new URL("../src/renderer/src/styles/layout.css", import.meta.url), "utf8");
    // 热区本体不绘制边框：视觉圆弧由 ::after 内缩绘制，避免被 shell 的
    // border-radius + overflow:hidden 裁切（热区边缘与外框重合导致不可见）。
    const handleRule = css.match(/\.session-modal-resize-handle\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(handleRule).not.toMatch(/border/);
    expect(handleRule).toContain("cursor: nwse-resize");
    // 局部层级：shell 内 thread 内容（composer 渐变层 --stack-sticky-control、
    // quotes/导航 --stack-popover）会盖住无层级的句柄，必须给句柄局部 z-index
    // 浮于其上；shell 自身因 transform + will-change 创建局部 stacking context，
    // 该值不会逃逸到 modal 之外的全局浮层。
    expect(handleRule).toContain("z-index: var(--stack-dialog)");
    const shellRule = css.match(/\.session-modal-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(shellRule).toContain("will-change: transform");
    // ::after 在右/下内缩 5px 处绘制圆弧，且不拦截指针事件。
    const arcRule = css.match(/\.session-modal-resize-handle::after\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(arcRule).toContain("content");
    expect(arcRule).toContain("right: 5px");
    expect(arcRule).toContain("bottom: 5px");
    expect(arcRule).toContain("border-right");
    expect(arcRule).toContain("border-bottom");
    expect(arcRule).toContain("pointer-events: none");
  });

  it("renders the shell without inline pixel size styles when un-resized", () => {
    const markup = renderFullscreen();
    // shell 只携带 transform（SSR style 序列化无空格），不携带 width/height
    // inline：未自定义尺寸时由 CSS 默认值决定，尺寸源在 shell 自身。
    expect(markup).toContain('class="session-modal-shell" style="transform:translate3d(0px, 0px, 0)"');
    expect(markup).not.toMatch(/session-modal-shell[^>]*style="[^"]*width:/);
    expect(markup).not.toMatch(/session-modal-shell[^>]*style="[^"]*height:/);
  });

  it("clamps to the midpoint when the viewport is smaller than the modal", () => {
    // 视口 200x200 < modal 720x560 + 2*16：min>max，单轴取 (min+max)/2 避免反向越界。
    vi.stubGlobal("window", { innerWidth: 200, innerHeight: 200 });
    try {
      expect(clampOffset(0, 0, 0, 0, 720, 560)).toEqual({ x: -260, y: -180 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores persisted fullscreen, modal open and geometry", () => {
    sessionScope.ready = true;
    sessionScope.persisted = {
      fullscreen: true,
      modalOpen: true,
      drag: { x: 12, y: -8 },
      size: { width: 640, height: 480 },
    };

    const markup = renderFullscreen();

    // 持久化值为状态源：全屏 + modal 打开 + 几何（自定义尺寸与拖拽偏移）一次性恢复。
    expect(markup).toContain('data-open="true"');
    expect(markup).toContain(
      'class="session-modal-shell" style="width:640px;height:480px;transform:translate3d(12px, -8px, 0)"',
    );
  });

  it("restores the new session's state on remount (session switch)", () => {
    sessionScope.ready = true;
    sessionScope.persisted = { fullscreen: true, modalOpen: false, drag: { x: 0, y: 0 }, size: null };
    const first = renderFullscreen();
    expect(first).toContain('data-open="false"');

    // 切换到另一个 session：SessionSurface 随 key 重挂载，lazy 初始化按新 record 的
    // 持久化值恢复，不保留上一个 session 的状态。
    sessionScope.persisted = {
      fullscreen: true,
      modalOpen: true,
      drag: { x: 40, y: 20 },
      size: { width: 600, height: 400 },
    };
    const second = renderFullscreen();
    expect(second).toContain('data-open="true"');
    expect(second).toContain('style="width:600px;height:400px;transform:translate3d(40px, 20px, 0)"');
  });

  it("keeps the persisted modal open preference when exiting fullscreen", () => {
    // 退出全屏只翻转 fullscreen：modalOpen 偏好保留，再次进入全屏恢复 modal 打开。
    expect(
      toggleSessionModalFullscreen({ fullscreen: true, modalOpen: true, drag: { x: 0, y: 0 }, size: null }),
    ).toEqual({ fullscreen: false, modalOpen: true, drag: { x: 0, y: 0 }, size: null });
    // 进入全屏不自动打开 modal。
    expect(
      toggleSessionModalFullscreen({ fullscreen: false, modalOpen: false, drag: { x: 0, y: 0 }, size: null }),
    ).toEqual({ fullscreen: true, modalOpen: false, drag: { x: 0, y: 0 }, size: null });
  });

  it("compares modal geometry by value", () => {
    expect(sameModalGeometry({ x: 0, y: 0 }, null, { x: 0, y: 0 }, null)).toBe(true);
    expect(
      sameModalGeometry({ x: 0, y: 0 }, { width: 720, height: 560 }, { x: 0, y: 0 }, { width: 720, height: 560 }),
    ).toBe(true);
    // 仅引用不同但值相同仍视为相等：外部 props 每次渲染新建对象不会触发同步/写回循环。
    expect(
      sameModalGeometry({ x: 0, y: 0 }, { width: 720, height: 560 }, { x: 0, y: 0 }, { width: 720, height: 560 }),
    ).toBe(true);
    expect(sameModalGeometry({ x: 1, y: 0 }, null, { x: 0, y: 0 }, null)).toBe(false);
    expect(sameModalGeometry({ x: 0, y: 0 }, null, { x: 0, y: 0 }, { width: 720, height: 560 })).toBe(false);
  });

  it("clamps persisted geometry to the current viewport", () => {
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
    try {
      // 未越界：尺寸与偏移原样保留。
      const within = clampPersistedGeometry({ x: 0, y: 0 }, { width: 640, height: 480 }, 1024, 768);
      expect(within).toEqual({ drag: { x: 0, y: 0 }, size: { width: 640, height: 480 } });
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("window", { innerWidth: 600, innerHeight: 400 });
    try {
      // 旧大窗口保存的几何在小视口越界：尺寸与位置都被 clamp 回视口内。
      const clamped = clampPersistedGeometry({ x: 300, y: 250 }, { width: 400, height: 300 }, 600, 400);
      expect(clamped.size).toEqual({ width: 360, height: 280 });
      expect(clamped.drag).toEqual({ x: 0, y: 56 });
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("window", { innerWidth: 200, innerHeight: 150 });
    try {
      // 视口比自定义最小尺寸还小时退让到视口可用范围，不会出现负尺寸。
      const tiny = clampPersistedGeometry({ x: 1000, y: 900 }, { width: 900, height: 700 }, 200, 150);
      expect(tiny.size).toEqual({ width: 168, height: 118 });
      expect(tiny.drag).toEqual({ x: 0, y: 56 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("computes the persisted state for modal open and geometry changes", () => {
    const base = { fullscreen: true, modalOpen: false, drag: { x: 0, y: 0 }, size: null };

    expect(setSessionModalOpen(base, true)).toEqual({ ...base, modalOpen: true });
    expect(setSessionModalOpen(base, false)).toEqual({ ...base, modalOpen: false });

    const next = setSessionModalGeometry(base, { x: 12, y: -8 }, { width: 640, height: 480 });
    expect(next).toEqual({
      fullscreen: true,
      modalOpen: false,
      drag: { x: 12, y: -8 },
      size: { width: 640, height: 480 },
    });
    // 取消自定义尺寸：size 回 null（CSS 默认尺寸）。
    expect(setSessionModalGeometry(base, { x: 12, y: -8 }, null)).toEqual({
      fullscreen: true,
      modalOpen: false,
      drag: { x: 12, y: -8 },
      size: null,
    });
  });
});
