import { clampMessageWidth, MESSAGE_WIDTH_DEFAULT } from "../../../shared/settings-config-contracts.ts";

/** 消息列宽度对应的根节点 CSS 变量，默认值由 styles/tokens.css 的 token 拥有。 */
export const MESSAGE_WIDTH_PROPERTY = "--layout-thread-max-width";

interface MessageWidthAttributeTarget {
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
}

/**
 * 把消息宽度写入 HTML 根节点：null（满屏）写 `none` 取消宽度限制，
 * 非默认数值经 clamp 后写入 `--layout-thread-max-width`，
 * 默认值移除变量回到 CSS token 回退（810px），线程、composer 等消费方自动跟随。
 */
export function applyMessageWidth(root: MessageWidthAttributeTarget, width: number | null): void {
  if (width === null) {
    root.style.setProperty(MESSAGE_WIDTH_PROPERTY, "none");
    return;
  }
  const clamped = clampMessageWidth(width);
  if (clamped === MESSAGE_WIDTH_DEFAULT) root.style.removeProperty(MESSAGE_WIDTH_PROPERTY);
  else root.style.setProperty(MESSAGE_WIDTH_PROPERTY, `${clamped}px`);
}
