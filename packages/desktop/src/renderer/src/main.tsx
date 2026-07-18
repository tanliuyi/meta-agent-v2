import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { DesktopProvider } from "./state/desktop-context.tsx";
import { initializeTheme, ThemeProvider } from "./state/theme.tsx";
import "./styles.css";

initializeTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing renderer root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <DesktopProvider>
          <App />
        </DesktopProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
