import { lazy } from "react";

export const LazyTerminalView = lazy(() =>
  import("./terminal-view.tsx").then(({ TerminalView }) => ({ default: TerminalView })),
);
