import type { DomainState } from "@zoltbot/core";
import { expect, it } from "vitest";
import { firstNativePromptPending, runtimeConfigurationFence } from "./runtime-configuration.js";

function fixture(): DomainState {
  return {
    thread: [{ id: "thread", agentId: "profile", projectId: "project", archived: false }],
    agent: [
      {
        id: "profile",
        definitionId: "definition",
        permissionProfile: "read_only",
        instructions: "initial",
        archived: false,
      },
    ],
    agentDefinition: [{ id: "definition", launch: { env: {} } }],
    project: [{ id: "project", roots: [{ path: "/fixture" }], archived: false }],
  };
}
it("rejects changed launch authority and unavailable selected entities", () => {
  for (const mutate of [
    (state: DomainState) => {
      if (state.agent?.[0]) state.agent[0].instructions = "changed";
    },
    (state: DomainState) => {
      if (state.agentDefinition?.[0]) state.agentDefinition[0].launch = { env: { KEY: "changed" } };
    },
    (state: DomainState) => {
      if (state.project?.[0]) state.project[0].roots = [];
    },
    (state: DomainState) => {
      if (state.thread?.[0]) state.thread[0].archived = true;
    },
    (state: DomainState) => {
      state.project = [];
    },
  ]) {
    const state = fixture(),
      check = runtimeConfigurationFence(state, "thread");
    mutate(state);
    expect(() => check(state)).toThrow("runtime_configuration_changed");
  }
});
it("allows display changes and keeps an independent initial snapshot", () => {
  const state = fixture(),
    check = runtimeConfigurationFence(state, "thread");
  if (state.agent?.[0]) state.agent[0].name = "Renamed";
  if (state.thread?.[0]) state.thread[0].lastActivityAt = "later";
  expect(() => check(state)).not.toThrow();
  if (state.agent?.[0]) state.agent[0].permissionProfile = "workspace_write";
  expect(() => check(state)).toThrow("runtime_configuration_changed");
});

it("keeps first-prompt evidence across connections without confusing another native session", () => {
  const state: DomainState = {
    session: [
      { id: "old", threadId: "thread", nativeId: "native" },
      { id: "new", threadId: "thread", nativeId: "native" },
      { id: "other", threadId: "thread", nativeId: "another" },
    ],
    turn: [{ sessionId: "other" }],
  };
  expect(firstNativePromptPending(state, "thread", "native")).toBe(true);
  state.turn?.push({ sessionId: "old" });
  expect(firstNativePromptPending(state, "thread", "native")).toBe(false);
});
