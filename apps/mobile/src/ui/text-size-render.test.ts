import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import type { ReactNode } from "react";
import { beforeAll, expect, it } from "vitest";

// P6 with host shims: the real theme and store, so the chosen size reaches the drawn text. Not
// native layout, dragging or screen-reader behavior.
const uiRequire = createRequire(createRequire(import.meta.url).resolve("@zoltbot/ui/chat/types"));
const { createElement } = uiRequire("react") as typeof import("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server") as {
  renderToStaticMarkup(element: ReactNode): string;
};

type Store = { getState(): { set(size: number): void } };
let exports: { TextSizeSettings: () => ReactNode; useTextSize: Store };
const saved: string[] = [];

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: path.resolve("apps/mobile/src/ui"),
      contents: `
      export { TextSizeSettings } from './TextSizeSettings';
      export { useTextSize } from '../state/text-size';
    `,
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "expo-secure-store", "zustand"],
  });
  const component =
    (tag: string) =>
    ({ children, accessibilityValue, accessibilityRole, style }: Record<string, unknown>) =>
      createElement(
        tag,
        {
          role: accessibilityRole,
          "aria-valuetext": (accessibilityValue as { text?: string } | undefined)?.text,
          "data-style": JSON.stringify(style),
        },
        children as ReactNode,
      );
  const native = {
    View: component("div"),
    Text: component("span"),
    Pressable: component("button"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    useColorScheme: () => "dark",
  };
  const secureStore = {
    AFTER_FIRST_UNLOCK: 0,
    getItemAsync: async () => null,
    setItemAsync: async (_key: string, value: string) => {
      saved.push(value);
    },
  };
  // Server rendering reads a zustand store's first state; this one reads the current state.
  const zustand = {
    create: (init: (set: (patch: object) => void, get: () => object) => object) => {
      let state: Record<string, unknown> = {};
      const set = (patch: object) => {
        state = { ...state, ...patch };
      };
      state = init(set, () => state) as Record<string, unknown>;
      return Object.assign((select: (s: unknown) => unknown = (s) => s) => select(state), {
        getState: () => state,
      });
    },
  };
  const require = (id: string) =>
    id === "react-native"
      ? native
      : id === "expo-secure-store"
        ? secureStore
        : id === "zustand"
          ? zustand
          : uiRequire(id);
  const module = { exports: {} as typeof exports };
  new Function("require", "module", "exports", result.outputFiles[0]?.text ?? "")(
    require,
    module,
    module.exports,
  );
  exports = module.exports;
});

const render = () => renderToStaticMarkup(createElement(exports.TextSizeSettings));
const previewStyle = (html: string) =>
  html.match(/data-style="([^"]*)">Your agent finished/)?.[1]?.replaceAll("&quot;", '"') ?? "";

it("draws the preview at the chosen size and says the size as a percentage", () => {
  const before = render();
  expect(before).toContain('role="adjustable"');
  expect(before).toContain('aria-valuetext="100%"');
  expect(previewStyle(before)).toContain('"fontSize":15');
  exports.useTextSize.getState().set(1.3);
  const after = render();
  expect(after).toContain('aria-valuetext="130%"');
  expect(previewStyle(after)).toContain('"fontSize":20');
  expect(previewStyle(after)).toContain('"lineHeight":27');
  expect(saved).toEqual(["1.3"]);
});
