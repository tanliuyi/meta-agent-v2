import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget =  "http://100.91.230.10:4317";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(process.cwd(), "src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 4318,
      proxy: {
        "/marketplace-api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/marketplace-api/, ""),
        },
      },
    },
  };
});
