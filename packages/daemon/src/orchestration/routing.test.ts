import { describe, expect, it } from "vitest";
import { type RoutingContext, resolveRoute, routeRequest } from "./routing.js";

const context: RoutingContext = {
  models: [
    { definitionId: "codex", model: "sol", label: "Sol", efforts: ["high"], ready: true },
    { definitionId: "claude", model: "opus", label: "Opus", efforts: ["medium"], ready: true },
  ],
  profiles: [
    {
      id: "security",
      name: "Security reviewer",
      definitionId: "claude",
      model: "opus",
      effort: "medium",
    },
  ],
  current: { definitionId: "codex", model: "sol" },
};
describe("phase model resolution", () => {
  it("supports an ordinary request without configured roles and explicit cross-provider assignments", () => {
    const result = resolveRoute(
      {
        intent: "phased_task",
        phases: [
          { role: "plan", instruction: "Plan" },
          { role: "review", instruction: "Review", model: "Opus", effort: "medium" },
        ],
      },
      context,
    );
    expect(result.phases.map((phase) => [phase.definitionId, phase.model, phase.effort])).toEqual([
      ["codex", "sol", undefined],
      ["claude", "opus", "medium"],
    ]);
  });
  it("resolves named profiles and prefers project settings over app settings", () => {
    const result = resolveRoute(
      { intent: "single_task", phases: [{ role: "review", instruction: "Review" }] },
      {
        ...context,
        app: { review: { model: "sol" } },
        project: { review: { profile: "Security reviewer" } },
      },
    );
    expect(result.phases[0]).toMatchObject({
      profileId: "security",
      model: "opus",
      effort: "medium",
    });
  });
  it("refuses unavailable models, unsupported effort, and ambiguous names", () => {
    const route = {
      intent: "single_task" as const,
      phases: [{ role: "test", instruction: "Test", model: "missing" }],
    };
    expect(() => resolveRoute(route, context)).toThrow("unavailable");
    expect(() =>
      resolveRoute(
        {
          ...route,
          phases: [{ role: "test", instruction: "Test", model: "sol", effort: "medium" }],
        },
        context,
      ),
    ).toThrow("does not support");
    expect(() =>
      resolveRoute(
        { ...route, phases: [{ role: "test", instruction: "Test", model: "sol" }] },
        {
          ...context,
          models: [
            ...context.models,
            { definitionId: "other", model: "sol", label: "Sol", efforts: ["high"], ready: true },
          ],
        },
      ),
    ).toThrow("Which model");
  });
  it("does not permit chat output to contain tasks", () => {
    expect(() =>
      resolveRoute({ intent: "chat", phases: [{ role: "build", instruction: "Build" }] }, context),
    ).toThrow("invalid_route");
  });
  it("validates router output rather than trusting extra permissions or arbitrary fields", async () => {
    await expect(
      routeRequest(
        "Build it",
        context,
        {
          infer: async () => ({
            text: JSON.stringify({
              intent: "single_task",
              phases: [{ role: "build", instruction: "Build", permissionProfile: "unrestricted" }],
            }),
          }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});

it("uses a connected fallback when the current model is absent and supports cross-provider role defaults", () => {
  const route = {
    intent: "single_task" as const,
    phases: [{ role: "review", instruction: "Review" }],
  };
  expect(
    resolveRoute(route, { ...context, project: { review: { model: "opus" } } }).phases[0]?.model,
  ).toBe("opus");
  expect(
    resolveRoute(route, { ...context, current: { definitionId: "missing", model: "missing" } })
      .phases[0]?.model,
  ).toBe("sol");
});

it("accepts model family names only when the discovered catalog resolves them uniquely", async () => {
  const { discoveredAliases } = await import("./catalog.js");
  expect(discoveredAliases("gpt-6.1-sol", "GPT-6.1 Sol")).toContain("sol");
  expect(discoveredAliases("claude-opus-5.2", "Opus 5.2")).toContain("opus 5.x");
  expect(discoveredAliases("gpt-6.1-sol", "GPT-6.1 Sol")).not.toContain("gpt");
});

it("prefers an exact model id over other models' family aliases", () => {
  const result = resolveRoute(
    { intent: "single_task", phases: [{ role: "review", instruction: "Review", model: "sonnet" }] },
    {
      profiles: [],
      models: [
        { definitionId: "claude", model: "sonnet", label: "Sonnet", efforts: [], ready: true },
        {
          definitionId: "claude",
          model: "claude-sonnet-4-6",
          label: "Sonnet 4.6",
          aliases: ["sonnet"],
          efforts: [],
          ready: true,
        },
      ],
    },
  );
  expect(result.phases[0]?.model).toBe("sonnet");
});
