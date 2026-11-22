import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { AgentModelOption, AgentStatus } from "../../../shared/ipc";
import { listAgents, ProviderModelPicker } from "./ProviderModelPicker";

const model = (provider: string, providerName: string, id: string, name = id) =>
  ({
    id,
    name,
    provider,
    providerName,
    description: "",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  }) as AgentModelOption;

const claude = [
  model("claude", "Claude Code", "opus", "Opus"),
  model("claude", "Claude Code", "sonnet", "Sonnet"),
];
const status = {
  phase: "ready",
  providers: [
    { id: "claude", name: "Claude Code", state: "available", version: "2.4.0", message: null },
  ],
} as unknown as AgentStatus;

function open(props: Partial<Parameters<typeof ProviderModelPicker>[0]> = {}) {
  render(() => (
    <ProviderModelPicker
      value="opus"
      modelOptions={claude}
      agentStatus={status}
      onChange={() => {}}
      {...props}
    />
  ));
  fireEvent.click(screen.getByRole("button", { name: /^Agent model/ }));
}

it("lists ready agents first, in onboarding order, and leaves out agents that aren't installed", () => {
  const options = [
    model("cursor", "Cursor", "composer-2.5"),
    model("codex", "Codex", "gpt-5.5"),
    model("claude", "Claude Code", "opus"),
  ];
  const agents = listAgents(options, {
    phase: "ready",
    providers: [
      {
        id: "antigravity",
        name: "Antigravity",
        state: "sign-in-required",
        version: null,
        message: null,
      },
      { id: "gemini", name: "Gemini CLI", state: "not-installed", version: null, message: null },
      { id: "cursor", name: "Cursor", state: "available", version: null, message: null },
      { id: "codex", name: "Codex", state: "available", version: null, message: null },
      { id: "claude", name: "Claude Code", state: "available", version: null, message: null },
    ],
  } as unknown as AgentStatus);
  expect(agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor", "antigravity"]);
});

it("shows the agent's name and version, marks the default and folds older models away", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    model("claude", "Claude Code", `m${index}`, `Model ${index}`),
  );
  open({ value: "m0", modelOptions: many });
  expect(screen.getByRole("tab", { name: "Claude Code" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByText("2.4.0")).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(6);
  expect(screen.getByText("default")).toBeTruthy();
  const older = screen.getByRole("button", { name: /Older models/ });
  expect(older.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(older);
  expect(screen.getAllByRole("option")).toHaveLength(9);
});

it("offers setup for an agent that isn't ready", () => {
  const setUp = vi.fn();
  open({
    onSetUpAgent: setUp,
    agentStatus: {
      ...status,
      providers: [
        ...(status.providers ?? []),
        {
          id: "antigravity",
          name: "Antigravity",
          state: "sign-in-required",
          version: null,
          message: null,
        },
      ],
    } as AgentStatus,
  });
  fireEvent.click(screen.getByRole("tab", { name: "Antigravity, Sign in required" }));
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  expect(setUp).toHaveBeenCalled();
});

it("searches every agent and picks with the keyboard", () => {
  const change = vi.fn();
  open({
    onChange: change,
    modelOptions: [...claude, model("codex", "Codex", "gpt-5.5")],
    agentStatus: {
      ...status,
      providers: [
        ...(status.providers ?? []),
        { id: "codex", name: "Codex", state: "available", version: null, message: null },
      ],
    } as AgentStatus,
  });
  const search = screen.getByRole("combobox", { name: "Search models" });
  fireEvent.input(search, { target: { value: "gpt" } });
  expect(screen.getAllByRole("option").map((row) => row.getAttribute("data-label"))).toEqual([
    "gpt-5.5",
  ]);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(change).toHaveBeenCalledWith("gpt-5.5");
});

it("A8: stars the active model and lists it first", async () => {
  const setStarred = vi.fn(async (ids: string[]) => ids);
  Object.assign(window, { openbot: { models: { starred: async () => [], setStarred } } });
  open();
  const search = screen.getByRole("combobox", { name: "Search models" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("button", { name: "Star Sonnet" }));
  expect(setStarred).toHaveBeenCalledWith(["sonnet"]);
  await waitFor(() =>
    expect(screen.getAllByRole("option").map((row) => row.getAttribute("data-label"))).toEqual([
      "Sonnet",
      "Opus",
    ]),
  );
});

it("A5: hides Speed when the provider has no faster tier", () => {
  open({ fastMode: null, onFastModeChange: async () => true });
  expect(screen.queryByText("Speed")).toBeNull();
});

it("A5: shows the cost while Fast is on and says when a change fails", async () => {
  const change = vi.fn(async () => false);
  open({ fastMode: true, onFastModeChange: change });
  expect(screen.getByText("Uses more of your plan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Speed/ }));
  fireEvent.click(screen.getByRole("option", { name: "Standard" }));
  expect(change).toHaveBeenCalledWith(false);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Fast mode didn't turn off. Try again."),
  );
});

it("offers the model's effort levels and shows the effort on the button", () => {
  const change = vi.fn();
  open({ effort: "medium", onEffortChange: change });
  expect(
    screen.getByRole("button", { name: "Agent model: Opus", description: /Medium/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Effort/ }));
  fireEvent.click(screen.getByRole("option", { name: "High" }));
  expect(change).toHaveBeenCalledWith("high");
});
