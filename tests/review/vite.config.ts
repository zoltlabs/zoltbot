import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: {
    alias: {
      "react-dom": path.resolve("packages/ui/node_modules/react-dom"),
      react: path.resolve("packages/ui/node_modules/react"),
    },
  },
  server: { host: "127.0.0.1", port: 5193, strictPort: true },
});
