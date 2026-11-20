import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { dark } from "../theme/tokens.generated";

// The kit with host shims: checks what the sheets are given and what rows render, not native
// layout, touch or screen-reader behavior.
const uiRequire = createRequire(createRequire(import.meta.url).resolve("@zoltbot/ui/chat/types"));
const { createElement } = uiRequire("react") as typeof import("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server") as {
  renderToStaticMarkup(element: ReactNode): string;
};

type SheetOptions = {
  title?: string;
  message?: string;
  options: string[];
  cancelButtonIndex?: number;
  destructiveButtonIndex?: number | number[];
  disabledButtonIndices?: number[];
};
type AlertButton = { text: string; style?: string; onPress?: () => void };

let os = "ios";
let sheet: { options: SheetOptions; choose: (index: number) => void } | undefined;
let alert: { title: string; message?: string; buttons: AlertButton[] } | undefined;
let kit: Record<string, (...args: never[]) => unknown>;

beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("apps/mobile/src/ui/kit.tsx")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native"],
    plugins: [
      {
        name: "native-host",
        setup(builder) {
          builder.onResolve({ filter: /\/theme$/ }, () => ({ path: "kit-theme", external: true }));
        },
      },
    ],
  });
  const component =
    (tag: string) =>
    ({ children, accessibilityLabel, accessibilityActions, style }: Record<string, unknown>) =>
      createElement(
        tag,
        {
          "aria-label": accessibilityLabel,
          "data-actions": accessibilityActions
            ? (accessibilityActions as { name: string }[]).map((action) => action.name).join("|")
            : undefined,
          "data-style": typeof style === "function" ? undefined : JSON.stringify(style),
        },
        children as ReactNode,
      );
  const native = {
    View: component("div"),
    Text: component("span"),
    Pressable: component("button"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    get Platform() {
      return { OS: os };
    },
    ActionSheetIOS: {
      showActionSheetWithOptions(options: SheetOptions, choose: (index: number) => void) {
        sheet = { options, choose };
      },
    },
    Alert: {
      alert(title: string, message: string | undefined, buttons: AlertButton[]) {
        alert = { title, ...(message ? { message } : {}), buttons };
      },
    },
  };
  const theme = {
    mono: "monospace",
    touch: 44,
    type: {},
    avatarColors: () => ({ body: "", eye: "", screen: "" }),
    useTheme: () => ({ scheme: "dark", c: dark }),
  };
  const require = (id: string) =>
    id === "react-native" ? native : id === "kit-theme" ? theme : uiRequire(id);
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  new Function("require", "module", "exports", result.outputFiles[0]?.text ?? "")(
    require,
    module,
    module.exports,
  );
  kit = module.exports;
});

beforeEach(() => {
  os = "ios";
  sheet = undefined;
  alert = undefined;
});

const showMenu = (...args: unknown[]) => (kit.showMenu as (...a: unknown[]) => void)(...args);
const showConfirmSheet = (args: unknown) => (kit.showConfirmSheet as (a: unknown) => void)(args);

it("opens the menu as an action sheet with a separate Cancel row", () => {
  const chosen: string[] = [];
  showMenu(
    [
      { label: "Pin", onPress: () => chosen.push("pin") },
      { label: "Mark as unread", disabled: true, onPress: () => chosen.push("unread") },
      { label: "Archive", onPress: () => chosen.push("archive") },
      { label: "Delete agent…", destructive: true, onPress: () => chosen.push("delete") },
    ],
    "Ada",
  );
  expect(sheet?.options).toEqual({
    title: "Ada",
    options: ["Pin", "Mark as unread", "Archive", "Delete agent…", "Cancel"],
    cancelButtonIndex: 4,
    destructiveButtonIndex: [3],
    disabledButtonIndices: [1],
  });
  sheet?.choose(4);
  sheet?.choose(1);
  sheet?.choose(3);
  expect(chosen).toEqual(["delete"]);
});

it("falls back to an alert without the disabled items off iOS", () => {
  os = "android";
  showMenu([
    { label: "Pin", onPress: () => {} },
    { label: "Archive", disabled: true, onPress: () => {} },
    { label: "Delete agent…", destructive: true, onPress: () => {} },
  ]);
  expect(sheet).toBeUndefined();
  expect(alert?.buttons.map((button) => [button.text, button.style])).toEqual([
    ["Pin", "default"],
    ["Delete agent…", "destructive"],
    ["Cancel", "cancel"],
  ]);
});

it("confirms with a destructive verb-plus-object button and Cancel", () => {
  let confirmed = 0;
  showConfirmSheet({
    title: "Delete Ada?",
    body: "Removes the agent, its queue and the files only this chat used.",
    confirmLabel: "Delete agent",
    onConfirm: () => confirmed++,
  });
  expect(sheet?.options).toEqual({
    title: "Delete Ada?",
    message: "Removes the agent, its queue and the files only this chat used.",
    options: ["Delete agent", "Cancel"],
    destructiveButtonIndex: 0,
    cancelButtonIndex: 1,
  });
  sheet?.choose(1);
  expect(confirmed).toBe(0);
  sheet?.choose(0);
  expect(confirmed).toBe(1);
});

it("lists the menu items as VoiceOver actions", () => {
  const html = renderToStaticMarkup(
    createElement(
      kit.Menu as unknown as (props: Record<string, unknown>) => ReactNode,
      {
        label: "Ada",
        items: [
          { label: "Pin", onPress: () => {} },
          { label: "Archive", disabled: true, onPress: () => {} },
        ],
      },
      "Ada",
    ),
  );
  expect(html).toContain('data-actions="Pin"');
});

it("shows a row's detail at the trailing edge, after the title", () => {
  const html = renderToStaticMarkup(
    createElement(kit.Row as unknown as (props: Record<string, unknown>) => ReactNode, {
      title: "Ada",
      detail: "2 min",
      onPress: () => {},
    }),
  );
  expect(html).toContain('aria-label="Ada, 2 min"');
  expect(html.indexOf("Ada</span>")).toBeLessThan(html.indexOf("2 min</span>"));
  expect(html).toMatch(/<\/div><span[^>]*>2 min<\/span>/);
});

it("shows a row's error under the title and reads it with the row", () => {
  const html = renderToStaticMarkup(
    createElement(kit.Row as unknown as (props: Record<string, unknown>) => ReactNode, {
      title: "Nov 20, 9:00 AM",
      detail: "Skipped",
      error: "Previous occurrence is still active",
      onPress: () => {},
    }),
  );
  expect(html).toContain(
    'aria-label="Nov 20, 9:00 AM, Skipped, Previous occurrence is still active"',
  );
  expect(html.indexOf("9:00 AM</span>")).toBeLessThan(html.indexOf("still active</span>"));
  expect(html).toContain(dark.danger);
});
