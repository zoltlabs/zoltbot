import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
export default defineConfig({
  root: ".",
  resolve: {
    alias: {
      react: path.dirname(require.resolve("react/package.json")),
      "react-dom": path.dirname(require.resolve("react-dom/package.json")),
    },
  },
  server: { host: "127.0.0.1", port: 5191, strictPort: true },
});
