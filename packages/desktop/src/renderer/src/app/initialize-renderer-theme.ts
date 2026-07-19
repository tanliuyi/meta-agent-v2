import { initializeTheme } from "@renderer/state/theme-preference";

// 在 React root 创建前同步主题属性，避免首帧使用错误 token。
initializeTheme();
