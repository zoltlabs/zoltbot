import { afterEach, expect, it, vi } from "vitest";
import { completeOnboarding, needsOnboarding, resetOnboarding } from "./onboarding-state.js";

afterEach(() => vi.unstubAllGlobals());

it("shows first-run setup, remembers completion, and resets without deleting workspace data", () => {
  const values = new Map<string, string>([["zoltbot.theme.v1", "light"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  expect(needsOnboarding()).toBe(true);
  completeOnboarding();
  expect(needsOnboarding()).toBe(false);
  resetOnboarding();
  expect(needsOnboarding()).toBe(true);
  expect(values.get("zoltbot.theme.v1")).toBe("light");
});

it("keeps setup available when browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("unavailable");
    },
    setItem: () => {
      throw new Error("unavailable");
    },
    removeItem: () => {
      throw new Error("unavailable");
    },
  });
  expect(needsOnboarding()).toBe(true);
  expect(completeOnboarding).not.toThrow();
  expect(resetOnboarding).not.toThrow();
});
