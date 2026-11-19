import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  main: {
    // Zoltbot workspace packages ship TypeScript sources, so main bundles them.
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@zoltbot/protocol", "@zoltbot/daemon", "@zoltbot/artifact-kit"],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [solidPlugin(), tailwindcss()],
  },
});
