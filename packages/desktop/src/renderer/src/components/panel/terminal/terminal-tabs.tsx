import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalTabsState } from "../../../../../shared/contracts.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

/**
 * 会话级终端的多 tab 状态：以 baseTerminalId 为默认第 1 个 tab，新建 tab 的 id 形如
 * `${baseTerminalId}-2`/`${baseTerminalId}-3`（满足主进程 /^[a-zA-Z0-9_-]{1,64}$/
 * 槽位校验）。只剩最后一个 tab 时 close 不移除，而是回调 onLastClosed，
 * 由挂载点决定是否收起整个终端视图。
 *
 * 提供 persist 读写后，tabs 状态存入 session workbench state：挂载点切换/收起导致
 * 组件重挂载时不丢失（否则新建编号与 tab 列表全部重置，重复 + 会生成同名终端）。
 */
export function useTerminalTabs(
  baseTerminalId: string,
  options?: {
    onLastClosed?: () => void;
    persist?: {
      read(): TerminalTabsState | undefined;
      write(state: TerminalTabsState): void;
    };
  },
): { tabs: string[]; activeId: string; create(): void; activate(id: string): void; close(id: string): void } {
  const { onLastClosed, persist } = options ?? {};
  // 初始值：优先持久化状态（含跨刷新恢复），缺失时回退单 tab。
  // 校验持久化的完整性：tabs 非空且 activeId 在列表中，否则回退。
  // 用 lazy 初始化只读一次（rerender-lazy-state-init）：persist.read 是轻量快照读，
  // 但调用方每次渲染会新建 persist 对象，避免重复执行。
  const [initial] = useState(() => {
    const persisted = persist?.read();
    const valid = persisted !== undefined && persisted.tabs.length > 0 && persisted.tabs.includes(persisted.activeId);
    return valid ? persisted : { tabs: [baseTerminalId], activeId: baseTerminalId };
  });
  const initialTabs = initial.tabs;
  const initialActive = initial.activeId;
  const [tabs, setTabs] = useState<string[]>(initialTabs);
  const [activeId, setActiveId] = useState(initialActive);
  // 新建编号从持久化 tab 列表的最大后缀 +1 开始（base 自身是第 1 个），
  // 单调递增保证 id 永不重复；无持久化时从 2 开始。
  const nextIndexRef = useRef(Math.max(2, ...initialTabs.map(terminalSuffixNumber)) + 1);
  const onLastClosedRef = useRef(onLastClosed);
  useEffect(() => {
    onLastClosedRef.current = onLastClosed;
  }, [onLastClosed]);
  // persist 读写回调由调用方每次渲染新建，用 ref 固定最新值，避免写回 effect 每帧重跑。
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // tabs/activeId 变化即写回持久层（挂载点卸载前已完成最后写入）。
  useEffect(() => {
    const currentPersist = persistRef.current;
    if (!currentPersist) return;
    const current = currentPersist.read();
    if (current?.tabs.join("\u0000") === tabs.join("\u0000") && current.activeId === activeId) return;
    currentPersist.write({ tabs, activeId });
  }, [activeId, tabs]);

  /** 新建 tab：追加 `${baseTerminalId}-${递增数}` 并切换为激活。 */
  const create = useCallback(() => {
    const nextId = `${baseTerminalId}-${nextIndexRef.current}`;
    nextIndexRef.current += 1;
    setTabs((current) => [...current, nextId]);
    setActiveId(nextId);
  }, [baseTerminalId]);

  /** 切换激活 tab。 */
  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  /** 关闭 tab：多于 1 个时移除并激活相邻 tab（优先下一个，无则上一个）；只剩 1 个时回调 onLastClosed。 */
  const close = useCallback(
    (id: string) => {
      if (tabs.length > 1) {
        const index = tabs.indexOf(id);
        if (index === -1) return;
        const nextTabs = tabs.filter((tab) => tab !== id);
        setTabs(nextTabs);
        if (activeId === id) setActiveId(nextTabs[Math.min(index, nextTabs.length - 1)]);
      } else {
        onLastClosedRef.current?.();
      }
    },
    [activeId, tabs],
  );

  return { tabs, activeId, create, activate, close };
}

/**
 * 解析终端 id 的数字后缀（`panel-3` → 3；无后缀/非数字返回 0）。
 * 用于从持久化 tab 列表推导下一个新建编号，避免重复 id 复用旧 PTY。
 */
function terminalSuffixNumber(terminalId: string): number {
  const dash = terminalId.lastIndexOf("-");
  if (dash === -1) return 0;
  const suffix = Number(terminalId.slice(dash + 1));
  return Number.isFinite(suffix) ? suffix : 0;
}

/**
 * 终端 tab 展示名（参考 VS Code 终端标签：不含场景语义）：
 * 基础 tab（无编号后缀）显示“终端”，后续 tab 按编号显示“终端 N”。
 */
function terminalTabLabel(terminalId: string): string {
  const suffix = terminalSuffixNumber(terminalId);
  return suffix > 0 ? `终端 ${suffix}` : "终端";
}

/**
 * 终端 tab 条（视觉对齐侧边栏 workbench tabs，复用 panel-tab-* 结构）：
 * 单 tab 时也渲染（含可关闭 pill 与 + 新建按钮），对齐 VS Code 终端标签区。
 * 激活 tab 由 panel-tab-item 的 data-active 驱动高亮，关闭按钮 hover 显示。
 */
export function TerminalTabs(props: {
  tabs: string[];
  activeId: string;
  onCreate(): void;
  onActivate(id: string): void;
  onClose(id: string): void;
}): JSX.Element {
  const { tabs, activeId, onCreate, onActivate, onClose } = props;
  return (
    <div className="panel-tab-list" role="tablist" aria-label="终端标签页">
      {tabs.map((terminalId) => {
        const active = terminalId === activeId;
        return (
          <div key={terminalId} className="panel-tab-item" data-active={active || undefined}>
            <button
              type="button"
              className="panel-tab-trigger"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onActivate(terminalId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onActivate(terminalId);
                }
              }}
            >
              <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="panel-tab-label">{terminalTabLabel(terminalId)}</span>
            </button>
            <button
              type="button"
              className="panel-tab-close"
              aria-label={`关闭终端 ${terminalTabLabel(terminalId)}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(terminalId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <TooltipIconButton tooltip="新建终端" aria-label="新建终端" className="terminal-tab-new" onClick={onCreate}>
        <Plus size={13} />
      </TooltipIconButton>
    </div>
  );
}
