import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { DesktopProvider } from "./state/desktop-context.tsx";
import "@assistant-ui/react-markdown/styles/dot.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
	throw new Error("Missing renderer root element");
}

createRoot(rootElement).render(
	<StrictMode>
		<DesktopProvider>
			<App />
		</DesktopProvider>
	</StrictMode>,
);
