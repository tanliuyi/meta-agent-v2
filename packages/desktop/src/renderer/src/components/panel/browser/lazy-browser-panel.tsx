import { lazy } from "react";

export const LazyBrowserPanel = lazy(() =>
  import("./browser-panel.tsx").then(({ BrowserPanel }) => ({ default: BrowserPanel })),
);
