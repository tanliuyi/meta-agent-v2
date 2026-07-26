import { initializeUiFontPreferences } from "@renderer/state/font-preference";

// 在 React root 创建前同步字体偏好，避免首帧使用错误字体或字号。
initializeUiFontPreferences();
