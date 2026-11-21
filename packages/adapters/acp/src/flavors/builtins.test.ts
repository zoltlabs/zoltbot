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

it("A6: offers Gemini CLI next to Antigravity, and Mistral Vibe", () => {
  const registry = builtinRegistry();
  const gemini = acpDefinitions.find((definition) => definition.id === "gemini");
  expect(gemini?.launch.args).toEqual(["--acp"]);
  expect(registry.get("antigravity").id).toBe("antigravity");
  const methods = [
    { id: "oauth-personal", name: "Log in with Google" },
    { id: "gemini-api-key", name: "Gemini API key" },
  ];
  expect(registry.get("gemini").chooseAuth?.(methods, { GEMINI_API_KEY: "synthetic" })).toEqual({
    methodId: "gemini-api-key",
  });
  // A saved Google sign-in is used as is; Zoltbot never starts an interactive login.
  expect(registry.get("gemini").chooseAuth?.(methods, {})).toBeUndefined();
  const vibe = acpDefinitions.find((definition) => definition.id === "vibe");
  expect(vibe?.binaryNames).toEqual(["vibe-acp"]);
  expect(vibe?.launch.command).toBe("{binary}");
  expect(registry.get("vibe").id).toBe("vibe");
});
