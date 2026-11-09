import { expect, it } from "vitest";
import { acpDefinitions } from "../definitions.js";
import { builtinRegistry } from "./index.js";

it("loads built in definitions and their exact verified launch routes", () => {
  const registry = builtinRegistry();
  for (const definition of acpDefinitions)
    expect(registry.get(definition.flavor).id).toBe(definition.flavor);
  expect(acpDefinitions.slice(0, 3).map((d) => d.launch.args)).toEqual([
    ["acp"],
    ["acp"],
    ["--no-auto-update", "agent", "stdio"],
  ]);
});
it("uses advertised noninteractive auth methods and never invents a login method", () => {
  const registry = builtinRegistry();
  const methods = [
    { id: "xai.api_key", name: "API key" },
    { id: "cached_token", name: "Cached" },
  ];
  expect(registry.get("grok").chooseAuth?.(methods, { XAI_API_KEY: "synthetic" })).toEqual({
    methodId: "xai.api_key",
    meta: { headless: true },
  });
  expect(registry.get("grok").chooseAuth?.(methods, {})).toEqual({
    methodId: "cached_token",
    meta: { headless: true },
  });
  expect(
    registry.get("grok").chooseAuth?.([{ id: "grok.com", name: "Interactive login" }], {}),
  ).toBeUndefined();
  expect(
    registry.get("cursor").chooseAuth?.([{ id: "cursor_login", name: "Existing login" }], {}),
  ).toEqual({ methodId: "cursor_login" });
});

it("uses Antigravity as the built-in Gemini path", () => {
  expect(acpDefinitions.some((definition) => definition.id === "gemini")).toBe(false);
  expect(() => builtinRegistry().get("gemini")).toThrow("unknown_acp_flavor");
  expect(builtinRegistry().get("antigravity").id).toBe("antigravity");
});
