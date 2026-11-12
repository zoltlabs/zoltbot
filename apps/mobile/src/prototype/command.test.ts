import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { build } from "esbuild";
import type { ComponentType, ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { dark, light } from "../theme/tokens.generated";
import { answerRequest, columns, marks, queue, sorted, widens } from "./model";
import { sampleProject, simulate, stressProject } from "./sample";

// Bundle the actual components with native host shims. This checks rendered content and
// adaptive props; it cannot measure native line breaking or VoiceOver focus.
const uiRequire = createRequire(createRequire(import.meta.url).resolve("@zoltbot/ui/chat/types"));
const { createElement } = uiRequire("react") as typeof import("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server") as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
let fontScale = 1;
let Command: ComponentType<{ initialLayout?: "board" | "stacked" }>;
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./Command.tsx", import.meta.url))],
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
      "react-native-safe-area-context",
    ],
    plugins: [
      {
        name: "native-theme",
        setup(builder) {
          builder.onResolve({ filter: /\/theme$/ }, () => ({
            path: "prototype-theme",
            external: true,
          }));
        },
      },
    ],
  });
  const component =
    (tag: string) =>
    ({ children, accessibilityLabel, style, ...props }: Record<string, unknown>) =>
      createElement(
        tag,
        {
          "aria-label": accessibilityLabel,
          "data-style": JSON.stringify(style),
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
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? children : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale }),
    Alert: { alert: () => {} },
  };
  const theme = { mono: "monospace", touch: 44, useTheme: () => ({ c: dark }), type: {} };
  const module = {
    exports: {} as { Command: ComponentType<{ initialLayout?: "board" | "stacked" }> },
  };
  const require = (id: string) =>
    id === "react-native"
      ? native
      : id === "prototype-theme"
        ? theme
        : id === "react-native-safe-area-context"
          ? { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }
          : id === "react-native-svg"
            ? { default: component("svg"), Path: component("path"), Rect: component("rect") }
            : uiRequire(id);
  const output = result.outputFiles[0];
  if (!output) throw new Error("Component bundle missing");
  new Function("require", "module", "exports", output.text)(require, module, module.exports);
  Command = module.exports.Command;
});

describe("project command", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("uses schema-valid requests and includes full, tiny and empty projects", () => {
    const full = sampleProject("full", now);
    expect(full.initiatives.flatMap((i) => i.agents)).toHaveLength(36);
    for (const entry of queue(full))
      expect(parse(InteractionSchema, entry.request)).toEqual(entry.request);
    expect(sampleProject("tiny", now).initiatives[0]?.agents).toHaveLength(2);
    expect(sampleProject("empty", now).initiatives).toHaveLength(0);
    expect(stressProject(now).initiatives.flatMap((i) => i.agents)).toHaveLength(40);
  });
  it("sorts waiting initiatives first, oldest first, without mutating source", () => {
    const project = sampleProject("full", now);
    const original = project.initiatives.map((i) => i.id);
    expect(
      sorted(project)
        .slice(0, 3)
        .map((i) => i.id),
    ).toEqual(["initiative-5", "initiative-3", "initiative-0"]);
    expect(project.initiatives.map((i) => i.id)).toEqual(original);
    expect(sorted(sampleProject("empty"))).toEqual([]);
  });
  it("requires confirmation for choices that authorize further actions", () => {
    for (const choice of ["allow_session", "allow_accept_edits", "allow_rule", "reject_rule"])
      expect(widens(choice)).toBe(true);
    expect(widens("allow_once")).toBe(false);
    expect(widens("reject_once")).toBe(false);
  });
  it("maps five distinct shapes and labels, with later sharing idle", () => {
    expect(new Set(Object.values(marks).map((mark) => mark.shape)).size).toBe(5);
    expect(Object.values(marks).every((mark) => mark.label.length)).toBe(true);
    expect(marks.later.shape).toBe(marks.idle.shape);
    expect(marks.needs_you.label).toBe("Needs you");
  });
  it("answers oldest first and advances without dropping another request", () => {
    const project = sampleProject("full", now);
    const before = queue(project);
    expect(before.map((e) => e.request.createdAt)).toEqual(
      before.map((e) => e.request.createdAt).sort(),
    );
    const first = before[0];
    if (!first) throw new Error("Missing fixture request");
    const after = answerRequest(project, first.request.id, "Approved once");
    expect(queue(after).map((e) => e.request.id)).toEqual(before.slice(1).map((e) => e.request.id));
    expect(queue(project)).toHaveLength(before.length);
    expect(answerRequest(after, first.request.id, "Duplicate")).toBe(after);
  });
  it("simulation changes activity, adds a request and finishes without touching pending drafts", () => {
    let project = sampleProject("full", now);
    const old = queue(project).map((e) => e.request);
    project = simulate(project, 0, now);
    project = simulate(project, 1, now);
    expect(queue(project)).toHaveLength(old.length + 1);
    project = simulate(project, 2, now);
    for (const request of old)
      expect(queue(project).find((e) => e.request.id === request.id)?.request).toEqual(request);
    expect(
      project.initiatives
        .flatMap((i) => i.agents)
        .some((a) => a.result === "Regression suite passes; ready for review."),
    ).toBe(true);
  });
  it("renders every initiative and control at the largest accessibility text scale", () => {
    fontScale = 3.2;
    expect(columns(fontScale, "board")).toBe(1);
    const html = renderToStaticMarkup(createElement(Command));
    for (const initiative of sampleProject().initiatives) expect(html).toContain(initiative.name);
    expect(html).toContain("Unblock 8");
    expect(html).toContain("Pause live sample");
    expect(html).not.toContain("numberOfLines");
    expect(html).toContain("100%");
    fontScale = 1;
    expect(columns(fontScale, "board")).toBe(2);
    const stacked = renderToStaticMarkup(createElement(Command, { initialLayout: "stacked" }));
    expect(stacked).toContain("Try compact board");
    expect(stacked).not.toContain("48%");
  });
});

it("measures every semantic text and meaningful boundary pair in both themes", () => {
  const luminance = (hex: string) =>
    (hex.slice(1).match(/../g) ?? [])
      .map((part) => {
        const x = Number.parseInt(part, 16) / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
  const ratio = (a: string, b: string) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const palette of [dark, light])
    for (const surface of ["bg-page", "bg-raised"] as const) {
      for (const token of [
        "text",
        "text-secondary",
        "accent-text",
        "attention",
        "ok",
        "danger",
      ] as const)
        expect(
          ratio(palette[token], palette[surface]),
          `${token} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      expect(ratio(palette["border-control"], palette[surface])).toBeGreaterThanOrEqual(3);
    }
});
