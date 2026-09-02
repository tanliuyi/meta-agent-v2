import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.EIA_API_PORT ?? "3000";
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom", "yjs"] },
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
});
