import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionModalPersistedState } from "../../../shared/contracts.ts";
import { ChatThread } from "./chat/chat-thread.tsx";
import { Topbar } from "./layout/topbar.tsx";
import { BottomTerminal } from "./panel/terminal/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";
import { useSessionScope, useSessionWorkbenchSelector } from "./session-context.tsx";
import { type ModalDragState, type ModalSizeState, SessionModal } from "./session-modal.tsx";

interface SessionSurfaceProps {
  /** 初始全屏态（测试注入用，默认 false）。页面运行期不传；持久化值为正常状态源。 */
  initialFullscreen?: boolean;
}

/** 无持久化记录时的默认开关与几何。 */
const DEFAULT_MODAL_STATE: SessionModalPersistedState = {
  fullscreen: false,
  modalOpen: false,
  drag: { x: 0, y: 0 },
  size: null,
};

/** 切换全屏：仅翻转 fullscreen，保留 modalOpen（退出全屏不清 modal 打开偏好）。 */
export function toggleSessionModalFullscreen(state: SessionModalPersistedState): SessionModalPersistedState {
  return { ...state, fullscreen: !state.fullscreen };
}

/** 更新 modal 打开状态。 */
export function setSessionModalOpen(state: SessionModalPersistedState, open: boolean): SessionModalPersistedState {
  return { ...state, modalOpen: open };
}

/** 更新 modal 几何（拖拽偏移与自定义尺寸；size 为 null 表示未缩放）。 */
export function setSessionModalGeometry(
  state: SessionModalPersistedState,
  drag: ModalDragState,
  size: ModalSizeState | null,
): SessionModalPersistedState {
  return { ...state, drag, size };
}

/** The complete UI for the currently mounted session. */
export function SessionSurface({ initialFullscreen = false }: SessionSurfaceProps) {
  const { record, active, updateWorkbench } = useSessionScope();
  // 该 session 的 workbench 记录（store 就绪前为 null）；持久化的全屏/modal UI 状态从其中读取。
  const workbench = useSessionWorkbenchSelector((workbench) => workbench);
  const persisted = workbench?.sessionModal ?? null;
  // 全屏/modal 开关与几何为单一状态对象：lazy 初始化直接按持久化值恢复，
  // 无记录时用默认值 + initialFullscreen（测试注入）。
  const [modalState, setModalState] = useState<SessionModalPersistedState>(() =>
    persisted ? persisted : { ...DEFAULT_MODAL_STATE, fullscreen: initialFullscreen },
  );
  // 最新提交的持久化值：相同状态重复提交时跳过写回（如 Esc 的双路径），
  // 保证写入始终由显式 UI action 触发且不产生 set/write 循环。
  const lastPersistedRef = useRef<SessionModalPersistedState | null>(null);
  const uiRef = useRef(modalState);
  uiRef.current = modalState;

  // 写入始终基于当前完整状态（uiRef 读取最新值），避免 stale overwrite。
  const persistModalState = useCallback(
    (next: SessionModalPersistedState) => {
      const last = lastPersistedRef.current;
      const unchanged =
        last !== null &&
        last.fullscreen === next.fullscreen &&
        last.modalOpen === next.modalOpen &&
        last.drag.x === next.drag.x &&
        last.drag.y === next.drag.y &&
        (last.size === next.size ||
          (last.size !== null &&
            next.size !== null &&
            last.size.width === next.size.width &&
            last.size.height === next.size.height));
      if (unchanged) return;
      lastPersistedRef.current = next;
      updateWorkbench({ sessionModal: next });
    },
    [updateWorkbench],
  );

  const commit = useCallback(
    (next: SessionModalPersistedState) => {
      setModalState(next);
      persistModalState(next);
    },
    [persistModalState],
  );

  /** 全屏切换（WorkbenchPanel 按钮与 Esc 退出共用）。 */
  const commitFullscreen = useCallback((fullscreen: boolean) => commit({ ...uiRef.current, fullscreen }), [commit]);
  /** WorkbenchPanel 全屏按钮：翻转全屏态，保留 modalOpen 偏好。 */
  const toggleFullscreen = useCallback(() => commit(toggleSessionModalFullscreen(uiRef.current)), [commit]);
  /** 退出全屏：禁用宽度过渡动画后提交；不清 modalOpen 偏好。 */
  const exitFullscreen = useCallback(() => {
    const panel = document.querySelector<HTMLElement>(".workbench-panel");
    panel?.style.setProperty("transition", "none");
    requestAnimationFrame(() => panel?.style.removeProperty("transition"));
    commitFullscreen(false);
  }, [commitFullscreen]);
  /** modal 开关（Radix onOpenChange；Esc 关闭也经此持久化）。 */
  const commitModalOpen = useCallback((open: boolean) => commit(setSessionModalOpen(uiRef.current, open)), [commit]);
  /** 几何最终态（拖拽/缩放结束、键盘调整、视口 clamp）提交并持久化。 */
  const commitGeometry = useCallback(
    (drag: ModalDragState, size: ModalSizeState | null) => commit(setSessionModalGeometry(uiRef.current, drag, size)),
    [commit],
  );

  // workbench 延迟就绪（attach 重灌）后恢复持久化值；切换 session 会 remount，
  // lazy 初始化已按新 record 的持久化值恢复，hydrate 只处理 store 晚到的情况。
  // 只 hydrate 不写回：首次写入必须由用户 action 触发。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workbench || hydratedRef.current) return;
    hydratedRef.current = true;
    if (persisted) {
      lastPersistedRef.current = persisted;
      setModalState(persisted);
    }
  }, [workbench, persisted]);

  useEffect(() => {
    if (!modalState.fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Radix 在 document 捕获阶段处理 Esc 并关闭 modal（走 onOpenChange→commitModalOpen），
      // 此处 window 冒泡阶段读到的是关闭前的值：再关一次幂等（相同值被写入去重跳过），
      // 且不退出全屏。modal 未打开时 Esc 退出全屏。
      if (uiRef.current.modalOpen) {
        commitModalOpen(false);
        return;
      }
      exitFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commitModalOpen, exitFullscreen, modalState.fullscreen]);
  // ChatThread 单实例：普通态内联于 chat-workspace，全屏态置于 modal Content（portal 到 body）。
  // 两种形态互斥，同一时刻仅渲染一处；切换会重挂载，会话状态由 SessionProvider/runtime 持有不受影响。
  const thread = <ChatThread />;
  return (
    <>
      {modalState.fullscreen ? (
        <SessionModal
          open={modalState.modalOpen}
          onOpenChange={commitModalOpen}
          initialDrag={modalState.drag}
          initialSize={modalState.size}
          onGeometryChange={commitGeometry}
        >
          {thread}
        </SessionModal>
      ) : (
        <div className="session-surface-shell">
          <Topbar />
          <div
            className="workspace-row session-surface"
            data-session-key={record.key}
            data-active={active || undefined}
          >
            <main className="chat-workspace">{thread}</main>
          </div>
        </div>
      )}
      <BottomTerminal />
      <WorkbenchPanel
        fullscreen={modalState.fullscreen}
        onToggleFullscreen={modalState.fullscreen ? exitFullscreen : toggleFullscreen}
      />
    </>
  );
}
