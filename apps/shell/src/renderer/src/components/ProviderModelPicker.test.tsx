import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { AgentModelOption, AgentStatus } from "../../../shared/ipc";
import { ProviderModelPicker } from "./ProviderModelPicker";

const models = [
  {
    id: "opus",
    name: "Opus",
    provider: "claude",
    providerName: "Claude",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
  },
] as unknown as AgentModelOption[];
const status = {
  phase: "ready",
  providers: [{ id: "claude", state: "available", version: null, message: null }],
} as unknown as AgentStatus;

function open(fastMode: boolean | null, onFastModeChange = vi.fn(async () => true)) {
  render(() => (
    <ProviderModelPicker
      value="opus"
      modelOptions={models}
      agentStatus={status}
      onChange={() => {}}
      fastMode={fastMode}
      onFastModeChange={onFastModeChange}
    />
  ));
  fireEvent.click(screen.getByRole("button", { name: /^Agent model/ }));
  return onFastModeChange;
}

it("A5: hides Fast mode when the provider has no faster tier", () => {
  open(null);
  expect(screen.getByRole("dialog", { name: "Choose agent model" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Fast mode" })).toBeNull();
});

it("A5: shows the cost while Fast mode is on and says when a change fails", async () => {
  const change = open(
    true,
    vi.fn(async () => false),
  );
  const toggle = screen.getByRole("switch", { name: "Fast mode" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Uses more of your plan")).toBeTruthy();
  fireEvent.click(toggle);
  expect(change).toHaveBeenCalledWith(false);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Fast mode didn't turn off. Try again."),
  );
});

it("A8: stars the active model, lists it under Starred, and ranks search results", async () => {
  const setStarred = vi.fn(async (ids: string[]) => ids);
  Object.assign(window, {
    openbot: { models: { starred: async () => [], setStarred } },
  });
  const two = [...models, { ...models[0], id: "sonnet", name: "Sonnet" }] as AgentModelOption[];
  render(() => (
    <ProviderModelPicker value="opus" modelOptions={two} agentStatus={status} onChange={() => {}} />
  ));
  fireEvent.click(screen.getByRole("button", { name: /^Agent model/ }));
  const search = screen.getByRole("combobox", { name: "Search models" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Tab" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Star Sonnet");
  fireEvent.click(screen.getByRole("button", { name: "Star Sonnet" }));
  expect(setStarred).toHaveBeenCalledWith(["sonnet"]);
  await waitFor(() => expect(screen.getByRole("group", { name: "Starred" })).toBeTruthy());
  expect(screen.getByRole("button", { name: "Unstar Sonnet" })).toBeTruthy();

  fireEvent.input(search, { target: { value: "son" } });
  const options = screen.getAllByRole("option").map((row) => row.getAttribute("data-label"));
  expect(options).toEqual(["Sonnet"]);
});
