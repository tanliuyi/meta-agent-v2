import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

interface ResizeOptions {
	value: number;
	min: number;
	max: number;
	direction: 1 | -1;
	onCommit(value: number): void;
}

interface ResizeBinding {
	size: number;
	onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
	onKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
}

/** 提供带边界、键盘操作和延迟持久化的拖拽尺寸。 */
export function useResize(options: ResizeOptions): ResizeBinding {
	const [size, setSize] = useState(() => limitSize(options.value, options.min, options.max));
	const valueRef = useRef(size);
	const cleanupRef = useRef<(() => void) | null>(null);
	valueRef.current = size;

	useEffect(() => {
		const next = limitSize(options.value, options.min, options.max);
		valueRef.current = next;
		setSize(next);
	}, [options.max, options.min, options.value]);

	useEffect(() => () => cleanupRef.current?.(), []);

	const commit = useCallback(
		(next: number) => {
			valueRef.current = next;
			setSize(next);
			options.onCommit(next);
		},
		[options.onCommit],
	);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			cleanupRef.current?.();
			const horizontal = event.currentTarget.getAttribute("aria-orientation") === "horizontal";
			const startPoint = horizontal ? event.clientY : event.clientX;
			const startSize = valueRef.current;
			const move = (nextEvent: PointerEvent) => {
				const point = horizontal ? nextEvent.clientY : nextEvent.clientX;
				const next = limitSize(startSize + (point - startPoint) * options.direction, options.min, options.max);
				valueRef.current = next;
				setSize(next);
			};
			const stop = () => {
				cleanupRef.current?.();
				options.onCommit(valueRef.current);
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", stop);
				window.removeEventListener("pointercancel", stop);
				cleanupRef.current = null;
				document.body.classList.remove(horizontal ? "is-resizing-row" : "is-resizing-column");
			};
			cleanupRef.current = cleanup;
			document.body.classList.add(horizontal ? "is-resizing-row" : "is-resizing-column");
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", stop, { once: true });
			window.addEventListener("pointercancel", stop, { once: true });
		},
		[options.direction, options.max, options.min, options.onCommit],
	);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLElement>) => {
			const horizontal = event.currentTarget.getAttribute("aria-orientation") === "horizontal";
			const backward = horizontal ? event.key === "ArrowUp" : event.key === "ArrowLeft";
			const forward = horizontal ? event.key === "ArrowDown" : event.key === "ArrowRight";
			if (!backward && !forward) return;
			event.preventDefault();
			const delta = (backward ? -16 : 16) * options.direction;
			commit(limitSize(valueRef.current + delta, options.min, options.max));
		},
		[commit, options.direction, options.max, options.min],
	);

	return { size, onPointerDown, onKeyDown };
}

/** 将持久化或拖拽尺寸限制在当前视口允许范围内。 */
export function limitSize(value: number, min: number, max: number): number {
	return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
