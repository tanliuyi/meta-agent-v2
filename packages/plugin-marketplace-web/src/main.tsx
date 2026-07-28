import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "./app-router.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
