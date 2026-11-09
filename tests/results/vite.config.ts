import { defineConfig } from "vite";
import review from "../review/vite.config.js";
export default defineConfig({
  ...review,
  server: { host: "127.0.0.1", port: 5197, strictPort: true },
});
