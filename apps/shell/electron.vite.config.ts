import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  main: {
    // Zoltbot workspace packages ship TypeScript sources, so main bundles them. The Markdown
    // parser is bundled too, so the packaged app needs no extra installed dependencies.
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@zoltbot/protocol",
          "@zoltbot/daemon",
          "@zoltbot/artifact-kit",
          "mdast-util-from-markdown",
          "mdast-util-gfm",
          "micromark-extension-gfm",
        ],
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
    build: {
      rollupOptions: {
        // D4: the agent dock is its own page in its own window.
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          dock: resolve(__dirname, "src/renderer/dock.html"),
        },
      },
    },
  },
});
