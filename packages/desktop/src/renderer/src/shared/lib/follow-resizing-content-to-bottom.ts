interface BottomFollowViewport {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  addEventListener(type: "scroll", listener: EventListener): void;
  removeEventListener(type: "scroll", listener: EventListener): void;
}

interface BottomFollowOptions {
  respectUserScroll?: boolean;
}

/** Keep a nested scroll viewport pinned as its rendered content grows. */
export function followResizingContentToBottom(
  viewport: BottomFollowViewport,
  content: Element,
  { respectUserScroll = false }: BottomFollowOptions = {},
): () => void {
  let frame: number | undefined;
  let following = true;
  const handleScroll = () => {
    following = Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
  };
  const pin = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      // Self-recover from false-positive scroll events (elastic bounce, momentum
      // scroll end, scrollbar drag-release, etc.) that briefly pushed the viewport
      // off-bottom and flipped `following` to false. If the user is actually still
      // at the bottom, keep following regardless of the `following` flag.
      const isAtBottom = Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
      if (!following && !isAtBottom) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
  };

  const observer = new ResizeObserver(pin);
  observer.observe(content);
  if (respectUserScroll) viewport.addEventListener("scroll", handleScroll);
  pin();

  return () => {
    observer.disconnect();
    if (respectUserScroll) viewport.removeEventListener("scroll", handleScroll);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
