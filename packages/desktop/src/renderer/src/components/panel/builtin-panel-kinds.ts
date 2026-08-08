/**
 * 内置 workbench 面板 tab 的注册 kind 常量。
 * 独立于 builtin-panel-tabs.tsx，避免导入字符串常量时连带重型面板组件模块图。
 */

/** 新会话草稿面板的注册 kind；提交成功后由草稿组件自行关闭该 tab。 */
export const NEW_SESSION_PANEL_KIND = "draft";

/** 资源管理（文件）面板的注册 kind。 */
export const FILES_PANEL_KIND = "files";

/** 内置浏览器（IAB）面板的注册 kind。 */
export const BROWSER_PANEL_KIND = "browser";
