const FOLLOW_DURATION_MS = 1_500;

interface BottomFollowViewport {
  scrollHeight: number;
  scrollTop: number;
  style: { scrollBehavior: string };
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** Keep a newly selected thread pinned while its initially rendered content settles. */
export function followThreadSwitchToBottom(
  viewport: BottomFollowViewport,
  content: Element,
  durationMs = FOLLOW_DURATION_MS,
): () => void {
  let active = true;
  let frame: number | null = null;
  const previousScrollBehavior = viewport.style.scrollBehavior;
  viewport.style.scrollBehavior = "auto";

  const pin = () => {
    if (!active) return;
    viewport.scrollTop = viewport.scrollHeight;
  };
  const schedulePin = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      pin();
    });
  };
  const observer = new ResizeObserver(pin);
  const cancelOnUserInput: EventListener = () => stop();
  const inputEvents = ["pointerdown", "touchstart", "wheel"] as const;
  const timeout = globalThis.setTimeout(() => stop(), durationMs);

  function stop() {
    if (!active) return;
    active = false;
    globalThis.clearTimeout(timeout);
    if (frame !== null) cancelAnimationFrame(frame);
    observer.disconnect();
    viewport.style.scrollBehavior = previousScrollBehavior;
    for (const event of inputEvents) viewport.removeEventListener(event, cancelOnUserInput);
  }

  observer.observe(content);
  for (const event of inputEvents) viewport.addEventListener(event, cancelOnUserInput);
  pin();
  schedulePin();

  return stop;
}
