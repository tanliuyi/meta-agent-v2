import { RotateCcw, TerminalSquare, X } from "lucide-react";
import { useRef } from "react";
import { useDesktop } from "../../state/desktop-context.tsx";
import { Button } from "../ui/button.tsx";
import { useResize } from "../ui/use-resize.ts";
import { TerminalView, type TerminalViewHandle } from "./terminal-view.tsx";

/** 当前 session 独立的底部终端停靠区。 */
export function BottomTerminal() {
	const { project, snapshot, workbench, updateWorkbench } = useDesktop();
	const terminal = useRef<TerminalViewHandle>(null);
	if (!project || !snapshot || !workbench?.terminalOpen) return null;
	return (
		<OpenBottomTerminal
			height={workbench.terminalHeight}
			name={project.name}
			terminal={terminal}
			onHeightChange={(terminalHeight) => updateWorkbench({ terminalHeight })}
			onClose={() => updateWorkbench({ terminalOpen: false })}
		/>
	);
}

function OpenBottomTerminal({
	height,
	name,
	terminal,
	onHeightChange,
	onClose,
}: {
	height: number;
	name: string;
	terminal: React.RefObject<TerminalViewHandle | null>;
	onHeightChange(height: number): void;
	onClose(): void;
}) {
	const resize = useResize({
		value: height,
		min: 160,
		max: window.innerHeight * 0.58,
		direction: -1,
		onCommit: onHeightChange,
	});
	return (
		<section className="bottom-terminal" style={{ height: resize.size }}>
			<div
				className="resize-handle resize-handle-terminal"
				role="separator"
				tabIndex={0}
				aria-label="调整底部终端高度"
				aria-orientation="horizontal"
				aria-valuemin={160}
				aria-valuemax={Math.round(window.innerHeight * 0.58)}
				aria-valuenow={resize.size}
				onPointerDown={resize.onPointerDown}
				onKeyDown={resize.onKeyDown}
			/>
			<header>
				<div className="terminal-tab is-active">
					<TerminalSquare size={13} />
					<span>{name}</span>
				</div>
				<Button variant="ghost" size="icon" aria-label="重新启动终端" onClick={() => void terminal.current?.restart()}><RotateCcw size={14} /></Button>
				<Button variant="ghost" size="icon" aria-label="关闭终端" className="terminal-close" onClick={onClose}><X size={14} /></Button>
			</header>
			<TerminalView ref={terminal} terminalId="bottom" />
		</section>
	);
}
