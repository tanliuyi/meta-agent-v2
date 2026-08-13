import { AssistantModalPrimitive } from "@assistant-ui/react";
import GripHorizontal from "lucide-react/dist/esm/icons/grip-horizontal.mjs";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square.mjs";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button.tsx";
import { SessionModalContext } from "./session-modal-context.ts";

/** Modal 相对 Radix 初始定位的拖拽偏移（px）。 */
export interface ModalDragState {
  x: number;
  y: number;
}

/** Modal 面板尺寸（px）。 */
export interface ModalSizeState {
  width: number;
  height: number;
}

/**
 * 活动拖拽会话：pointerdown 时捕获固定起点，resize 重基准后同步更新，
 * 保证后续 move 只累计增量位移且使用最新视口边界。
 */
export interface ActiveDragState {
  pointerId: number;
  startDrag: ModalDragState;
  startPointer: { x: number; y: number };
  latestPointer: { x: number; y: number };
  baseLeft: number;
  baseTop: number;
  width: number;
  height: number;
}

/**
 * 活动缩放会话：pointerdown 时捕获起点尺寸、起点拖拽偏移与面板视觉左上角（视口坐标），
 * window resize 重基准后同步更新；缩放期间左上角保持不动（通过拖拽偏移补偿）。
 */
export interface ActiveResizeState {
  pointerId: number;
  startSize: ModalSizeState;
  startDrag: ModalDragState;
  startPointer: { x: number; y: number };
  latestPointer: { x: number; y: number };
  topLeft: { x: number; y: number };
}

/** Modal 四边距视口边缘的最小间距（px）。 */
const MODAL_MARGIN = 16;

/** 未缩放时的默认尺寸（px），与 layout.css 的 min() 表达式一致。 */
const MODAL_DEFAULT_WIDTH = 720;
const MODAL_DEFAULT_HEIGHT = 560;

/** 自定义缩放的最小尺寸（px）；视口过小时退让到 viewport - 2*MODAL_MARGIN。 */
const MODAL_MIN_WIDTH = 360;
const MODAL_MIN_HEIGHT = 280;

/** .session-modal-anchor 的 fixed right/bottom 偏移（px），见 layout.css。 */
const ANCHOR_OFFSET = 16;

/** .session-modal-trigger 高度（px），见 layout.css（40x40）。 */
const MODAL_TRIGGER_HEIGHT = 40;

/** Content side="top" 的 sideOffset（px），见下方 JSX。 */
const MODAL_SIDE_OFFSET = 16;

/** 键盘方向键移动/缩放步长（px）：普通 16，Shift 细调 1。 */
const DRAG_KEY_STEP = 16;
const DRAG_KEY_STEP_FINE = 1;

/** 仅主指针（鼠标左键/主触控点）可启动拖拽或缩放。 */
export function isEligiblePointerDown(button: number, isPrimary: boolean): boolean {
  return button === 0 && isPrimary;
}

/** 键盘方向键步长：Shift 细调 1px，否则 16px。 */
export function getDragStep(shiftKey: boolean): number {
  return shiftKey ? DRAG_KEY_STEP_FINE : DRAG_KEY_STEP;
}

/** 方向键 → 位移增量；其他键返回 null（不拦截）。 */
export function getKeyboardDelta(key: string, shiftKey: boolean): { x: number; y: number } | null {
  const step = getDragStep(shiftKey);
  switch (key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}

/**
 * 本次拖拽的偏移 = 拖拽起点偏移 + 指针相对起点的位移。
 * 起点在 pointerdown 时固定捕获，后续每个 move 都相对它计算，避免位移重复累计
 * （第二次 move 相对原始起点，而不是在第一次结果上继续叠加）。
 */
export function getDragOffset(
  startDrag: ModalDragState,
  startPointer: { x: number; y: number },
  currentPointer: { x: number; y: number },
): ModalDragState {
  return {
    x: startDrag.x + currentPointer.x - startPointer.x,
    y: startDrag.y + currentPointer.y - startPointer.y,
  };
}

/**
 * 本次缩放的尺寸 = 起点尺寸 + 指针相对起点的位移。
 * 同样以 pointerdown 时的起点为基准，避免连续 move 重复累计。
 */
export function getResizeSize(
  startSize: ModalSizeState,
  startPointer: { x: number; y: number },
  currentPointer: { x: number; y: number },
): ModalSizeState {
  return {
    width: startSize.width + currentPointer.x - startPointer.x,
    height: startSize.height + currentPointer.y - startPointer.y,
  };
}

/**
 * 缩放后对拖拽偏移的 top/end 锚定补偿。Radix 以 side="top" align="end" 定位
 * （右边缘对齐 anchor 右边缘、底边缘对齐 anchor 顶边 - sideOffset），shell 在锚点
 * 内 right/bottom 锚定：尺寸增大时面板左上向左上展开 delta；补偿偏移 = 起点偏移 +
 * 尺寸增量，使面板视觉左上角在缩放期间保持屏幕位置固定。
 */
export function getResizeDragOffset(
  startDrag: ModalDragState,
  startSize: ModalSizeState,
  nextSize: ModalSizeState,
): ModalDragState {
  return {
    x: startDrag.x + (nextSize.width - startSize.width),
    y: startDrag.y + (nextSize.height - startSize.height),
  };
}

/**
 * Radix top/end 布局基准（不含拖拽偏移）：左边缘 = viewport - ANCHOR_OFFSET - width，
 * 顶边缘 = viewport - ANCHOR_OFFSET - trigger 高 - sideOffset - height。窗口尺寸变化时
 * Radix 重定位异步发生，直接读 rect 会取到旧布局，故用该数学基准作为单一来源。
 */
export function getModalBasePosition(
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
): { left: number; top: number } {
  return {
    left: viewportWidth - ANCHOR_OFFSET - width,
    top: viewportHeight - ANCHOR_OFFSET - MODAL_TRIGGER_HEIGHT - MODAL_SIDE_OFFSET - height,
  };
}

/** 未缩放时的默认尺寸，与 layout.css .session-modal-shell 的 min() 表达式一致。 */
export function getDefaultModalSize(viewportWidth: number, viewportHeight: number): ModalSizeState {
  return {
    // 极小视口下退让值可能为负，1px 下限保证返回正尺寸。
    width: Math.max(1, Math.min(MODAL_DEFAULT_WIDTH, viewportWidth - 2 * MODAL_MARGIN)),
    height: Math.max(1, Math.min(MODAL_DEFAULT_HEIGHT, viewportHeight - 2 * MODAL_MARGIN)),
  };
}

/** 单轴 clamp：视口小于 modal + 2*MODAL_MARGIN 时 min>max，取中点避免反向越界。 */
function clampAxis(value: number, min: number, max: number): number {
  return min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);
}

/**
 * 把拖拽偏移约束在视口内：以 Radix 布局位置（不含 translate）为基准，
 * 保证 modal 四边距视口至少 MODAL_MARGIN。布局位置随窗口尺寸变化，
 * 因此 resize 时需以最新 rect 重新计算基准。
 */
export function clampOffset(
  x: number,
  y: number,
  baseLeft: number,
  baseTop: number,
  width: number,
  height: number,
): ModalDragState {
  return {
    x: clampAxis(x, MODAL_MARGIN - baseLeft, window.innerWidth - MODAL_MARGIN - width - baseLeft),
    y: clampAxis(y, MODAL_MARGIN - baseTop, window.innerHeight - MODAL_MARGIN - height - baseTop),
  };
}

/**
 * 把面板尺寸约束在最小尺寸与“左上角到视口右/下 MODAL_MARGIN 间距”之间。
 * 视口小于最小尺寸 + 2*MODAL_MARGIN 时，最小尺寸退让到视口允许范围。
 */
export function clampModalSize(
  size: ModalSizeState,
  viewportWidth: number,
  viewportHeight: number,
  topLeftX: number,
  topLeftY: number,
): ModalSizeState {
  // 极小视口（< 32px）下退让值可能为负，用 1px 下限保证返回正尺寸。
  const minWidth = Math.max(1, Math.min(MODAL_MIN_WIDTH, viewportWidth - 2 * MODAL_MARGIN));
  const minHeight = Math.max(1, Math.min(MODAL_MIN_HEIGHT, viewportHeight - 2 * MODAL_MARGIN));
  const maxWidth = Math.max(viewportWidth - MODAL_MARGIN - topLeftX, minWidth);
  const maxHeight = Math.max(viewportHeight - MODAL_MARGIN - topLeftY, minHeight);
  return {
    width: clampAxis(size.width, minWidth, maxWidth),
    height: clampAxis(size.height, minHeight, maxHeight),
  };
}

/**
 * resize 后重基准活动拖拽：起点偏移改为新 clamp 值、起点指针改为最近指针、
 * 边界改为调用方传入的布局基准与最新尺寸。布局基准必须取自不含 translate 的
 * Radix 布局位置（rect - resize 前的旧 offset），不能从旧 rect 与新 offset 推导，
 * 否则会把已应用的新位移混入基准，后续 move 按错误边界 clamp。
 */
export function rebaseActiveDrag(
  active: ActiveDragState,
  nextDrag: ModalDragState,
  bounds: { baseLeft: number; baseTop: number; width: number; height: number },
): ActiveDragState {
  return {
    ...active,
    startDrag: nextDrag,
    startPointer: active.latestPointer,
    baseLeft: bounds.baseLeft,
    baseTop: bounds.baseTop,
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * window resize 后重基准活动缩放会话：起点尺寸改为新 clamp 值、起点指针改为
 * 最近指针、左上角改为面板新位置。后续 move 只按增量缩放，不重复累计。
 */
export function rebaseActiveResize(
  active: ActiveResizeState,
  nextSize: ModalSizeState,
  nextTopLeft: { x: number; y: number },
  nextDrag: ModalDragState,
): ActiveResizeState {
  return {
    ...active,
    startSize: nextSize,
    startDrag: nextDrag,
    startPointer: active.latestPointer,
    topLeft: nextTopLeft,
  };
}

/** 两组几何是否值相等：drag 按坐标、size 按宽高（均为 null 或同宽高视为相等）。
 *  仅引用相等不算相等，避免外部 props 每次渲染新对象时触发无意义同步或写回循环。 */
export function sameModalGeometry(
  dragA: ModalDragState,
  sizeA: ModalSizeState | null,
  dragB: ModalDragState,
  sizeB: ModalSizeState | null,
): boolean {
  if (dragA.x !== dragB.x || dragA.y !== dragB.y) return false;
  if (sizeA === null || sizeB === null) return sizeA === sizeB;
  return sizeA.width === sizeB.width && sizeA.height === sizeB.height;
}

/** 把持久化恢复的几何按当前视口 clamp（尺寸 + 位置），供挂载/窗口 resize/晚到
 *  hydrate 同步共用同一套边界计算。返回 clamp 后的几何；与入参相同表示无需纠正。 */
export function clampPersistedGeometry(
  drag: ModalDragState,
  size: ModalSizeState | null,
  viewportWidth: number,
  viewportHeight: number,
): { drag: ModalDragState; size: ModalSizeState | null } {
  // 尺寸：仅自定义尺寸需要重算（未自定义时 CSS min() 随视口响应）。
  let nextSize = size;
  if (size) {
    const base = getModalBasePosition(viewportWidth, viewportHeight, size.width, size.height);
    nextSize = clampModalSize(size, viewportWidth, viewportHeight, base.left + drag.x, base.top + drag.y);
  }
  // 位置：以最新尺寸的数学基准求 clamp 边界。
  const effectiveSize = nextSize ?? getDefaultModalSize(viewportWidth, viewportHeight);
  const base = getModalBasePosition(viewportWidth, viewportHeight, effectiveSize.width, effectiveSize.height);
  const nextDrag = clampOffset(drag.x, drag.y, base.left, base.top, effectiveSize.width, effectiveSize.height);
  return { drag: nextDrag, size: nextSize };
}

/**
 * 全屏期间的浮动会话 modal。仅在全屏分支内渲染：退出全屏即卸载，几何由持久化层
 * 保存，重进全屏时经 initialDrag/initialSize 恢复；modal 关闭再打开时组件保持挂载。
 * 几何变更（拖拽/缩放结束、键盘调整、视口 clamp）经 onGeometryChange 低频提交。
 *
 * 尺寸架构：Radix Content 是 0x0 定位锚点（avoidCollisions=false），只决定 top/end
 * 布局位置，不持有尺寸；实际默认/自定义尺寸都写在 shell 上（绝对定位 right:0;
 * bottom:0，从锚点向左上展开）。尺寸与拖拽 transform 在同一 shell 上同帧更新，
 * 不依赖 Radix ResizeObserver 重定位，因此缩放不存在一帧跳动；左上角固定由
 * getResizeDragOffset 的 +delta 补偿实现（top/end 锚定下尺寸增大向左上展开）。
 */
export function SessionModal({
  open,
  onOpenChange,
  initialDrag,
  initialSize,
  onGeometryChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 持久化的拖拽偏移（挂载与外部变化时恢复）。 */
  initialDrag: ModalDragState;
  /** 持久化的自定义尺寸；null 表示未缩放（CSS 默认尺寸）。 */
  initialSize: ModalSizeState | null;
  /** 几何最终态变化（拖拽/缩放结束、键盘调整、视口 clamp）时提交给持久化层。 */
  onGeometryChange: (drag: ModalDragState, size: ModalSizeState | null) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<ModalDragState>(initialDrag);
  // 自定义尺寸：null 表示未缩放，尺寸由 CSS 默认（随 shell 与视口响应）。
  const [size, setSize] = useState<ModalSizeState | null>(initialSize);
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(drag);
  const sizeRef = useRef<ModalSizeState | null>(initialSize);
  // 进行中拖拽会话：pointerdown 捕获起点，resize 重基准，end/lostcapture 清空。
  const activeDragRef = useRef<ActiveDragState | null>(null);
  // 进行中缩放会话：pointerdown 捕获起点尺寸与左上角，resize 重基准，end/lostcapture 清空。
  const activeResizeRef = useRef<ActiveResizeState | null>(null);

  // 高频拖拽直写 DOM transform，避免每次 move 触发 React 渲染；结束或键盘操作时同步 state。
  const applyDrag = useCallback((next: ModalDragState) => {
    dragRef.current = next;
    const shell = shellRef.current;
    if (shell) {
      shell.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
    }
  }, []);

  // 高频缩放直写 shell DOM 尺寸（shell 持有实际尺寸），避免每次 move 触发 React 渲染；
  // 结束或键盘操作时同步 state。尺寸与 transform 同在 shell，单次样式重算内完成。
  const applySize = useCallback((next: ModalSizeState) => {
    sizeRef.current = next;
    const shell = shellRef.current;
    if (shell) {
      shell.style.width = `${next.width}px`;
      shell.style.height = `${next.height}px`;
    }
  }, []);

  // 把自定义尺寸与拖拽偏移 clamp 到当前视口，并重基准活动拖拽/缩放会话。
  // 布局基准用数学 top/end 锚定（getModalBasePosition）而非读取 rect：Radix 在窗口
  // resize 后异步重定位 wrapper，读 rect 会取到旧布局。尺寸源：自定义尺寸或 CSS 默认（shell）。
  // 几何被 clamp 时提交 onGeometryChange（持久化恢复值可能超出当前视口）。
  const clampToViewport = useCallback(() => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let changed = false;
    // 尺寸：仅自定义尺寸需要重算（未自定义时 CSS min() 随视口响应）。
    if (sizeRef.current) {
      const base = getModalBasePosition(viewportWidth, viewportHeight, sizeRef.current.width, sizeRef.current.height);
      const nextSize = clampModalSize(
        sizeRef.current,
        viewportWidth,
        viewportHeight,
        base.left + dragRef.current.x,
        base.top + dragRef.current.y,
      );
      if (nextSize.width !== sizeRef.current.width || nextSize.height !== sizeRef.current.height) {
        applySize(nextSize);
        setSize(nextSize);
        changed = true;
      }
    }
    // 位置：以最新尺寸的数学基准求 clamp 边界。
    const effectiveSize = sizeRef.current ?? getDefaultModalSize(viewportWidth, viewportHeight);
    const base = getModalBasePosition(viewportWidth, viewportHeight, effectiveSize.width, effectiveSize.height);
    const next = clampOffset(
      dragRef.current.x,
      dragRef.current.y,
      base.left,
      base.top,
      effectiveSize.width,
      effectiveSize.height,
    );
    if (next.x !== dragRef.current.x || next.y !== dragRef.current.y) {
      applyDrag(next);
      setDrag(next);
      changed = true;
    }
    // 无论位置是否变化，活动拖拽都要用最新边界重基准：resize 会改变 modal 的
    // 实际渲染尺寸与布局位置，即使 offset 未变，后续 pointermove 也必须基于
    // 新边界计算，否则会按旧视口越界。
    const active = activeDragRef.current;
    if (active) {
      activeDragRef.current = rebaseActiveDrag(active, next, {
        baseLeft: base.left,
        baseTop: base.top,
        width: effectiveSize.width,
        height: effectiveSize.height,
      });
    }
    // 活动缩放会话：起点尺寸、起点偏移与左上角改为新 clamp 值，后续 move 只增量缩放。
    const activeResize = activeResizeRef.current;
    if (activeResize) {
      activeResizeRef.current = rebaseActiveResize(
        activeResize,
        effectiveSize,
        { x: base.left + next.x, y: base.top + next.y },
        next,
      );
    }
    if (changed) {
      onGeometryChange(dragRef.current, sizeRef.current);
    }
  }, [applyDrag, applySize, onGeometryChange]);

  useEffect(() => {
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [clampToViewport]);

  // 挂载时把持久化恢复的几何 clamp 到当前视口（窗口可能已在两次会话间缩小）。
  useEffect(() => {
    clampToViewport();
  }, [clampToViewport]);

  // 外部几何变化（持久化 hydrate 晚到、父组件镜像更新）时同步内部状态，并立即
  // clamp 到当前视口：晚到 hydrate 的持久化值可能来自旧窗口尺寸，不能只写 refs/state。
  // 拖拽/缩放进行中跳过（finalize 已先同步 ref/state，回流的 props 与 refs 相等，
  // 不构成写回循环）；clamp 实际改变几何时经 onGeometryChange 回写纠正后的值。
  useEffect(() => {
    if (activeDragRef.current || activeResizeRef.current) return;
    if (sameModalGeometry(dragRef.current, sizeRef.current, initialDrag, initialSize)) return;
    dragRef.current = initialDrag;
    sizeRef.current = initialSize;
    setDrag(initialDrag);
    setSize(initialSize);
    clampToViewport();
  }, [clampToViewport, initialDrag, initialSize]);

  // modal 关闭时提交未结束拖拽/缩放的最终值并清空活动状态：关闭重开保留位置与尺寸；
  // 退出全屏卸载时 ref 随组件销毁自然重置。组件在 open=false 时仍挂载，此处 setState 安全。
  useEffect(() => {
    if (open) return;
    if (activeDragRef.current || activeResizeRef.current) {
      activeDragRef.current = null;
      activeResizeRef.current = null;
      // 缩放过程会同时改动尺寸与补偿后的拖拽偏移，关闭时一并提交。
      setSize(sizeRef.current);
      setDrag(dragRef.current);
      onGeometryChange(dragRef.current, sizeRef.current);
    }
  }, [open, onGeometryChange]);

  // 仅从拖拽条启动：消息区滚动与文本选择不受影响。pointer capture 后事件重定向到
  // 拖拽条，高频 pointermove 直写 DOM（translate），只在结束时同步一次 React 状态。
  // 布局基准取 shell rect（含拖拽 translate）减去当前偏移，得到不含 transform 的位置。
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isEligiblePointerDown(event.button, event.isPrimary)) return;
    // 拖拽与缩放会话互斥，防止 pointer capture 串扰。
    if (activeDragRef.current || activeResizeRef.current) return;
    const handle = event.currentTarget;
    const shell = shellRef.current;
    if (!shell) return;
    handle.setPointerCapture(event.pointerId);
    const rect = shell.getBoundingClientRect();
    activeDragRef.current = {
      pointerId: event.pointerId,
      startDrag: dragRef.current,
      startPointer: { x: event.clientX, y: event.clientY },
      latestPointer: { x: event.clientX, y: event.clientY },
      baseLeft: rect.left - dragRef.current.x,
      baseTop: rect.top - dragRef.current.y,
      width: rect.width,
      height: rect.height,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const latestPointer = { x: event.clientX, y: event.clientY };
    activeDragRef.current = { ...active, latestPointer };
    const offset = getDragOffset(active.startDrag, active.startPointer, latestPointer);
    const next = clampOffset(offset.x, offset.y, active.baseLeft, active.baseTop, active.width, active.height);
    applyDrag(next);
  };

  // 幂等收尾：主动 releasePointerCapture 会再触发 lostpointercapture，届时 active 已清空直接跳过。
  const finalizeDrag = (pointerId: number) => {
    const active = activeDragRef.current;
    if (!active || active.pointerId !== pointerId) return;
    activeDragRef.current = null;
    setDrag(dragRef.current);
    onGeometryChange(dragRef.current, sizeRef.current);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    finalizeDrag(event.pointerId);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    finalizeDrag(event.pointerId);
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    finalizeDrag(event.pointerId);
  };

  // 键盘移动：以 shell 当前 rect 重新求基准后 clamp，低频操作直接同步 DOM/ref/state。
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = getKeyboardDelta(event.key, event.shiftKey);
    if (!delta) return;
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    const rect = shell.getBoundingClientRect();
    const next = clampOffset(
      dragRef.current.x + delta.x,
      dragRef.current.y + delta.y,
      rect.left - dragRef.current.x,
      rect.top - dragRef.current.y,
      rect.width,
      rect.height,
    );
    applyDrag(next);
    setDrag(next);
    onGeometryChange(next, sizeRef.current);
  };

  // 仅从右下角手柄启动缩放：记录起点尺寸、起点拖拽偏移与视觉左上角（shell rect，
  // 已含拖拽 translate）。缩放期间左上角固定：尺寸增量由拖拽偏移补偿，右下角跟随指针。
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isEligiblePointerDown(event.button, event.isPrimary)) return;
    // 拖拽与缩放会话互斥，防止 pointer capture 串扰。
    if (activeDragRef.current || activeResizeRef.current) return;
    const handle = event.currentTarget;
    const shell = shellRef.current;
    if (!shell) return;
    handle.setPointerCapture(event.pointerId);
    const rect = shell.getBoundingClientRect();
    activeResizeRef.current = {
      pointerId: event.pointerId,
      startSize: { width: rect.width, height: rect.height },
      startDrag: dragRef.current,
      startPointer: { x: event.clientX, y: event.clientY },
      latestPointer: { x: event.clientX, y: event.clientY },
      topLeft: { x: rect.left, y: rect.top },
    };
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeResizeRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const latestPointer = { x: event.clientX, y: event.clientY };
    activeResizeRef.current = { ...active, latestPointer };
    const size = getResizeSize(active.startSize, active.startPointer, latestPointer);
    const next = clampModalSize(size, window.innerWidth, window.innerHeight, active.topLeft.x, active.topLeft.y);
    applySize(next);
    // 补偿 Radix top/end 基准随尺寸的变化，保持视觉左上角固定。
    const nextDrag = getResizeDragOffset(active.startDrag, active.startSize, next);
    applyDrag(nextDrag);
  };

  const finalizeResize = (pointerId: number) => {
    const active = activeResizeRef.current;
    if (!active || active.pointerId !== pointerId) return;
    activeResizeRef.current = null;
    // 缩放过程同时改动了尺寸与补偿后的拖拽偏移，结束时一并提交。
    setSize(sizeRef.current);
    setDrag(dragRef.current);
    onGeometryChange(dragRef.current, sizeRef.current);
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeResizeRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    finalizeResize(event.pointerId);
  };

  const onResizePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    finalizeResize(event.pointerId);
  };

  const onResizeLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    finalizeResize(event.pointerId);
  };

  // 键盘缩放：右/下增大，左/上缩小；以 shell 当前 rect 求最大边界后 clamp，
  // 并同步拖拽偏移补偿，保持视觉左上角固定。
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = getKeyboardDelta(event.key, event.shiftKey);
    if (!delta) return;
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    const rect = shell.getBoundingClientRect();
    const startSize = { width: rect.width, height: rect.height };
    const next = clampModalSize(
      { width: rect.width + delta.x, height: rect.height + delta.y },
      window.innerWidth,
      window.innerHeight,
      rect.left,
      rect.top,
    );
    applySize(next);
    setSize(next);
    const nextDrag = getResizeDragOffset(dragRef.current, startSize, next);
    applyDrag(nextDrag);
    setDrag(nextDrag);
    onGeometryChange(nextDrag, next);
  };

  return (
    <AssistantModalPrimitive.Root open={open} onOpenChange={onOpenChange} unstable_openOnRunStart={false}>
      <AssistantModalPrimitive.Anchor className="session-modal-anchor">
        <AssistantModalPrimitive.Trigger asChild>
          <TooltipIconButton tooltip="查看会话" aria-label="查看会话" side="left" className="session-modal-trigger">
            <MessagesSquare className="size-4" />
          </TooltipIconButton>
        </AssistantModalPrimitive.Trigger>
      </AssistantModalPrimitive.Anchor>
      <AssistantModalPrimitive.Content
        side="top"
        align="end"
        sideOffset={MODAL_SIDE_OFFSET}
        avoidCollisions={false}
        aria-label="会话对话"
        className="session-modal-content"
      >
        {/* 面板壳：绝对定位于 Content 锚点（right/bottom 对齐锚点右下角），持有实际
            默认/自定义尺寸；尺寸增长向左上展开，拖拽位移与尺寸同帧作用在壳上。 */}
        <div
          ref={shellRef}
          className="session-modal-shell"
          style={{
            width: size?.width,
            height: size?.height,
            transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`,
          }}
        >
          <div
            role="group"
            tabIndex={0}
            aria-label="拖动会话窗口"
            className="session-modal-drag-handle"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onLostPointerCapture}
            onKeyDown={onKeyDown}
          >
            <GripHorizontal className="size-4" />
          </div>
          <div className="session-modal-body">
            <SessionModalContext.Provider value>{children}</SessionModalContext.Provider>
          </div>
          <div
            role="group"
            tabIndex={0}
            aria-label="调整会话窗口大小"
            className="session-modal-resize-handle"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerCancel}
            onLostPointerCapture={onResizeLostPointerCapture}
            onKeyDown={onResizeKeyDown}
          />
        </div>
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
}
