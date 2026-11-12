import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import type { ComponentType, ReactNode } from "react";
import { beforeAll, expect, it } from "vitest";
import type { Snapshot } from "../data/transport";
import { dark, light } from "../theme/tokens.generated";

// Actual native components with host shims: verifies content and disclosure defaults,
// not native layout, touch geometry, focus, animation or screen-reader behavior.
const uiRequire = createRequire(createRequire(import.meta.url).resolve("@zoltbot/ui/chat/types"));
const { createElement } = uiRequire("react") as typeof import("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server") as {
  renderToStaticMarkup(element: ReactNode): string;
};
let components: Record<string, ComponentType<Record<string, unknown>>>;
let snapshot: Snapshot = { seq: 0, counters: {}, entities: {} };
let scheme: "dark" | "light" = "dark";
let status = "online";
let params = { id: "chat", item: "tool" };

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: path.resolve("apps/mobile/src/ui"),
      contents: `
      export { AssistantTurn } from './AssistantTurn';
      export { ChatOutcome } from './ChatOutcome';
      export { default as Options } from '../app/chat/options';
      export { default as ToolResult } from '../app/chat/tool';
      export { FormCard } from './interactions/FormCard';
      export { DiffBlock } from './interactions/parts';
    `,
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: [
      "react",
      "react/jsx-runtime",
      "react-native",
      "react-native-svg",
      "expo-router",
      "react-native-safe-area-context",
    ],
    plugins: [
      {
        name: "native-host",
        setup(builder) {
          builder.onResolve({ filter: /\/theme$/ }, () => ({ path: "chat-theme", external: true }));
          builder.onResolve({ filter: /(?:\/state\/link|^\.\/link)$/ }, () => ({
            path: "chat-link",
            external: true,
          }));
        },
      },
    ],
  });
  const component =
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      accessibilityState,
      style,
      ...props
    }: Record<string, unknown>) =>
      createElement(
        tag,
        {
          "aria-label": accessibilityLabel,
          "aria-expanded": (accessibilityState as { expanded?: boolean } | undefined)?.expanded,
          "data-style": JSON.stringify(style),
          "data-hint": props.accessibilityHint,
          ...(tag === "textarea" ? { defaultValue: props.value } : {}),
        },
        children as ReactNode,
      );
  const native = {
    View: component("div"),
    Text: component("span"),
    Pressable: component("button"),
    ScrollView: component("section"),
    TextInput: component("textarea"),
    Image: component("img"),
    Switch: component("input"),
    KeyboardAvoidingView: component("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    Animated: {
      Value: class {
        interpolate() {
          return 0;
        }
      },
      View: component("div"),
    },
    Platform: { OS: "ios" },
    Alert: { alert() {} },
    Share: { share: async () => ({}) },
  };
  const theme = {
    mono: "monospace",
    sans: "sans-serif",
    touch: 44,
    type: {},
    avatarColors: () => ({ body: "", eye: "", screen: "" }),
    useTheme: () => ({ scheme, c: scheme === "dark" ? dark : light }),
  };
  const client = { getState: () => ({ status, snapshot, call: async () => ({}) }) };
  const link = {
    useSnapshot: () => snapshot,
    useClient: (selector: (state: unknown) => unknown) => selector({ status, snapshot }),
    useLink: Object.assign((selector: (state: unknown) => unknown) => selector({ client }), {
      getState: () => ({ client }),
    }),
  };
  const require = (id: string) =>
    id === "react-native"
      ? native
      : id === "chat-theme"
        ? theme
        : id === "chat-link"
          ? link
          : id === "expo-router"
            ? { router: { push() {}, replace() {}, back() {} }, useLocalSearchParams: () => params }
            : id === "react-native-safe-area-context"
              ? { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }
              : id === "react-native-svg"
                ? {
                    __esModule: true,
                    default: component("svg"),
                    Path: component("path"),
                    Rect: component("rect"),
                    Defs: component("defs"),
                    LinearGradient: component("linearGradient"),
                    Stop: component("stop"),
                  }
                : uiRequire(id);
  const module = { exports: {} };
  const output = result.outputFiles[0];
  if (!output) throw new Error("Native component bundle missing");
  new Function("require", "module", "exports", output.text)(require, module, module.exports);
  components = module.exports as typeof components;
});
const render = (name: string, props: Record<string, unknown> = {}) => {
  const Component = components[name];
  if (!Component) throw new Error(`Missing component ${name}`);
  return renderToStaticMarkup(createElement(Component, props));
};
it("keeps meaningful messages visible and routine work collapsed in both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    scheme = theme;
    const html = render("AssistantTurn", {
      threadId: "chat",
      active: false,
      paused: false,
      rows: [
        { id: "m", kind: "message", text: "Found the cause.", streaming: false },
        {
          id: "thought",
          kind: "thought",
          text: "Detailed reasoning stays folded",
          streaming: false,
        },
        { id: "tool", kind: "tool", text: "Read file", status: "ok", streaming: false },
        { id: "answer", kind: "message", text: "**Fixed** the issue.", streaming: false },
      ],
    });
    expect(html).toContain("Found the cause.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Detailed reasoning stays folded");
    expect(html).toContain("Message actions");
  }
});
it("shows an unresolved failure outside collapsed activity", () => {
  const html = render("AssistantTurn", {
    threadId: "chat",
    active: false,
    paused: false,
    rows: [
      { id: "tool", kind: "tool", text: "Command failed", status: "failed", streaming: false },
    ],
  });
  expect(html).toContain("Command failed");
  expect(html).toContain("Opens the full tool result");
});
it("renders evidence receipts and omits generic banners for ordinary replies", () => {
  status = "online";
  snapshot = {
    seq: 1,
    counters: {},
    entities: {
      turn: [{ id: "t", threadId: "chat", status: "completed" }],
      item: [
        {
          id: "tool",
          kind: "tool",
          threadId: "chat",
          turnId: "t",
          body: { kind: "edit", status: "ok", diffs: [{ path: "a", patch: "+new" }] },
        },
      ],
    },
  };
  expect(render("ChatOutcome", { threadId: "chat" })).toContain("1 file changed");
  expect(render("ChatOutcome", { threadId: "chat" })).toContain("Review changes");
  snapshot.entities.item = [];
  expect(render("ChatOutcome", { threadId: "chat" })).toBe("");
});
it("opens only this chat's saved tool output and handles missing results", () => {
  params = { id: "chat", item: "tool" };
  snapshot = {
    seq: 1,
    counters: {},
    entities: {
      item: [
        {
          id: "tool",
          threadId: "chat",
          kind: "tool",
          body: {
            kind: "execute",
            title: "Run checks",
            status: "error",
            output: { exitCode: 2, stdout: "Check failed" },
          },
        },
      ],
    },
  };
  expect(render("ToolResult")).toContain("Exit code 2");
  expect(render("ToolResult")).toContain("Check failed");
  params = { id: "other", item: "tool" };
  expect(render("ToolResult")).toContain("not in the saved history");
});
it("offers browser handoff without collecting credentials in an empty form", () => {
  const html = render("FormCard", {
    request: {
      items: [{ id: "login", prompt: "Connect at https://example.invalid/auth" }],
      context: {},
    },
    disabled: false,
    submit: async () => true,
  });
  expect(html).toContain("Open example.invalid");
  expect(html).toContain("Continue");
  expect(html).not.toContain("textarea");
});
