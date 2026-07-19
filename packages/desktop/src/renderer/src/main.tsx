import { AppProviders } from "@renderer/app/app-providers";
import { AppRouter } from "@renderer/app/app-router";
import "@renderer/app/initialize-renderer-theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing renderer root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <AppRouter />
    </AppProviders>
  </StrictMode>,
);
