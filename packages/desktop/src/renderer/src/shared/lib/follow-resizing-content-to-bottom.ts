const BOTTOM_THRESHOLD_PX = 1;

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

/** Keep a nested scroll viewport pinned as its rendered content grows, following assistant-ui's scroll-state rules. */
export function followResizingContentToBottom(
  viewport: BottomFollowViewport,
  content: Element,
  { respectUserScroll = false }: BottomFollowOptions = {},
): () => void {
  let frame: number | undefined;
  let following = true;
  let lastScrollTop = viewport.scrollTop;
  let lastScrollHeight = viewport.scrollHeight;

  const handleScroll = () => {
    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const isAtBottom =
      scrollHeight <= clientHeight || Math.abs(scrollHeight - scrollTop - clientHeight) <= BOTTOM_THRESHOLD_PX;
    // assistant-ui only treats an upward movement with stable content as user input.
    const userScrolledUp = scrollTop < lastScrollTop && scrollHeight === lastScrollHeight;

    if (isAtBottom) following = true;
    else if (userScrolledUp) following = false;

    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
  };

  const pin = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!following || viewport.scrollHeight <= viewport.clientHeight) return;
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop = viewport.scrollTop;
      lastScrollHeight = viewport.scrollHeight;
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
