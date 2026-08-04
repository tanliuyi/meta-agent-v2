import { initializeTerminalPreferences } from "@renderer/state/terminal-preference";

// 在 React root 创建前同步终端字体偏好，避免首个终端使用错误字体或字号。
initializeTerminalPreferences();
