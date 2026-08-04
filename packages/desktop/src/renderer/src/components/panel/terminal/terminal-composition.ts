import type { Terminal } from "@xterm/xterm";

interface CompositionCell {
  getWidth(): number;
  isInverse(): number;
}

interface CompositionLine {
  readonly length: number;
  getCell(column: number): CompositionCell | undefined;
}

interface CompositionBuffer {
  readonly viewportY: number;
  getLine(row: number): CompositionLine | undefined;
}

export interface VisualCursorPosition {
  column: number;
  row: number;
}

export function findVisualCursor(
  buffer: CompositionBuffer,
  viewportRows: number,
  viewportColumns: number,
): VisualCursorPosition | undefined {
  const candidates: VisualCursorPosition[] = [];
  const viewportTop = buffer.viewportY;

  for (let row = viewportTop; row < viewportTop + viewportRows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const columns = Math.min(line.length, viewportColumns);
    for (let column = 0; column < columns; column += 1) {
      const cell = line.getCell(column);
      if (!cell?.isInverse() || cell.getWidth() === 0) continue;
      const isIndependentInverse = (candidate: CompositionCell | undefined) =>
        Boolean(candidate && candidate.getWidth() > 0 && candidate.isInverse());
      const leftInverse = column > 0 && isIndependentInverse(line.getCell(column - 1));
      const rightInverse = column + 1 < columns && isIndependentInverse(line.getCell(column + 1));
      if (leftInverse || rightInverse) continue;
      candidates.push({ column, row: row - viewportTop });
      if (candidates.length > 1) return undefined;
    }
  }

  return candidates[0];
}

export function calculateCompositionShift(cursorLeft: number, compositionWidth: number, viewportWidth: number): number {
  if (![cursorLeft, compositionWidth, viewportWidth].every(Number.isFinite) || viewportWidth <= 0) return 0;

  const left = Math.max(0, cursorLeft);
  const width = Math.min(Math.max(0, compositionWidth), viewportWidth);
  return Math.max(-left, Math.min(0, viewportWidth - left - width));
}

/** Keep xterm's in-progress IME text inside the terminal surface without changing its grid size. */
export function constrainTerminalComposition(terminalElement: HTMLElement, compositionView: HTMLElement): void {
  compositionView.style.transform = "";
  if (!compositionView.classList.contains("active")) return;

  const terminalBounds = terminalElement.getBoundingClientRect();
  const compositionBounds = compositionView.getBoundingClientRect();
  const shift = calculateCompositionShift(
    compositionBounds.left - terminalBounds.left,
    compositionBounds.width,
    terminalBounds.width,
  );
  if (shift !== 0) compositionView.style.transform = `translateX(${shift}px)`;
}

/** Anchor IME UI to a TUI's single-cell inverse-video caret when the hardware cursor is elsewhere. */
export function attachVisualCursorImeAnchor(terminal: Terminal): { dispose(): void } {
  const root = terminal.element;
  const textarea = terminal.textarea;
  const screen = root?.querySelector<HTMLElement>(".xterm-screen");
  const compositionView = root?.querySelector<HTMLElement>(".composition-view");
  if (!textarea || !screen || !compositionView) return { dispose() {} };

  let composing = false;
  let pinned: { left: string; top: string } | undefined;
  let renderSubscription: { dispose(): void } | undefined;

  const applyPin = (element: HTMLElement) => {
    if (!composing || !pinned) return;
    if (
      element.style.left === pinned.left &&
      element.style.top === pinned.top &&
      element.style.getPropertyPriority("left") === "important" &&
      element.style.getPropertyPriority("top") === "important"
    ) {
      return;
    }
    element.style.setProperty("left", pinned.left, "important");
    element.style.setProperty("top", pinned.top, "important");
  };

  const textareaObserver = new MutationObserver(() => applyPin(textarea));
  const compositionObserver = new MutationObserver(() => applyPin(compositionView));

  const updatePin = () => {
    if (!composing) return;
    const cursor = findVisualCursor(terminal.buffer.active, terminal.rows, terminal.cols);
    if (!cursor) return;

    const bounds = screen.getBoundingClientRect();
    const left = `${Math.round((cursor.column * bounds.width) / Math.max(terminal.cols, 1))}px`;
    const top = `${Math.round((cursor.row * bounds.height) / Math.max(terminal.rows, 1))}px`;
    if (pinned?.left === left && pinned.top === top) return;

    pinned = { left, top };
    applyPin(textarea);
    applyPin(compositionView);
  };

  const releasePin = () => {
    const hadPin = pinned !== undefined;
    composing = false;
    pinned = undefined;
    renderSubscription?.dispose();
    renderSubscription = undefined;
    if (!hadPin) return;
    textarea.style.removeProperty("left");
    textarea.style.removeProperty("top");
    compositionView.style.removeProperty("left");
    compositionView.style.removeProperty("top");
  };

  const handleCompositionStart = () => {
    composing = true;
    updatePin();
    renderSubscription?.dispose();
    renderSubscription = terminal.onRender(updatePin);
  };

  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", releasePin);
  textareaObserver.observe(textarea, { attributes: true, attributeFilter: ["style"] });
  compositionObserver.observe(compositionView, { attributes: true, attributeFilter: ["style"] });

  return {
    dispose() {
      releasePin();
      textarea.removeEventListener("compositionstart", handleCompositionStart);
      textarea.removeEventListener("compositionend", releasePin);
      textareaObserver.disconnect();
      compositionObserver.disconnect();
    },
  };
}
