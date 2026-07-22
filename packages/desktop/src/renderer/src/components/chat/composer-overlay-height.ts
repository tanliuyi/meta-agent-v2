const COMPOSER_OVERLAY_HEIGHT_PROPERTY = "--composer-overlay-height";
const THREAD_SCROLLBAR_WIDTH_PROPERTY = "--thread-scrollbar-width";

/** Mirror a portaled footer's dimensions into the scroll layout without breaking bottom follow. */
export function observeComposerOverlayHeight(
  root: HTMLElement,
  viewport: HTMLElement,
  footer: HTMLElement,
): () => void {
  const update = () => {
    const wasAtBottom = Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1;
    root.style.setProperty(COMPOSER_OVERLAY_HEIGHT_PROPERTY, `${footer.offsetHeight}px`);
    root.style.setProperty(THREAD_SCROLLBAR_WIDTH_PROPERTY, `${viewport.offsetWidth - viewport.clientWidth}px`);
    if (wasAtBottom) viewport.scrollTop = viewport.scrollHeight;
  };
  const observer = new ResizeObserver(update);
  observer.observe(viewport);
  observer.observe(footer);
  update();

  return () => {
    observer.disconnect();
    root.style.removeProperty(COMPOSER_OVERLAY_HEIGHT_PROPERTY);
    root.style.removeProperty(THREAD_SCROLLBAR_WIDTH_PROPERTY);
  };
}
