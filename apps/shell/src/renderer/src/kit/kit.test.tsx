import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Combobox,
  ConfirmDialog,
  Menu,
  type MenuItem,
  Popover,
  Select,
  showToast,
  ToastRegion,
  Tooltip,
} from ".";

/** Sends a key to the focused element. Enter on a button clicks it, as a browser does. */
function press(key: string, init: KeyboardEventInit = {}) {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const proceed = fireEvent.keyDown(target, { key, ...init });
  if (proceed && key === "Enter" && target instanceof HTMLButtonElement) fireEvent.click(target);
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  fireEvent.input(input);
}

function click(element: Element) {
  fireEvent.pointerDown(element);
  if (element instanceof HTMLElement) element.focus();
  fireEvent.click(element);
}

afterEach(() => {
  document.getElementById("zb-kit-layer")?.remove();
  vi.useRealTimers();
});

function MenuHarness(props: { groups: MenuItem[][] }) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
        More
      </button>
      <Show when={anchor()}>
        {(element) => (
          <Menu
            anchor={element()}
            label="Message actions"
            groups={props.groups}
            onClose={() => setAnchor(undefined)}
          />
        )}
      </Show>
    </>
  );
}

const item = (id: string, label: string, run = vi.fn(), extra: Partial<MenuItem> = {}) => ({
  id,
  label,
  run,
  ...extra,
});

describe("Menu", () => {
  it("focuses the first item, moves with arrows, Home, End and type-ahead", async () => {
    render(() => (
      <MenuHarness
        groups={[
          [item("reply", "Reply"), item("copy", "Copy")],
          [],
          [item("pin", "Pin"), item("hide", "Hide")],
        ]}
      />
    ));
    click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "Message actions" });
    expect(menu.closest("#zb-kit-layer")).not.toBeNull();
    expect(menu.querySelectorAll("hr")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Reply" })).toHaveFocus());
    press("ArrowDown");
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
    press("End");
    expect(screen.getByRole("menuitem", { name: "Hide" })).toHaveFocus();
    press("ArrowDown");
    expect(screen.getByRole("menuitem", { name: "Reply" })).toHaveFocus();
    press("ArrowUp");
    expect(screen.getByRole("menuitem", { name: "Hide" })).toHaveFocus();
    press("p");
    expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus();
    press("Home");
    expect(screen.getByRole("menuitem", { name: "Reply" })).toHaveFocus();
  });

  it("runs the chosen item after closing and returns focus to the trigger", async () => {
    const pin = vi.fn(() => expect(screen.queryByRole("menu")).toBeNull());
    render(() => <MenuHarness groups={[[item("reply", "Reply"), item("pin", "Pin", pin)]]} />);
    const trigger = screen.getByRole("button", { name: "More" });
    click(trigger);
    press("ArrowDown");
    press("Enter");
    expect(pin).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes on Escape, Tab and a press outside", async () => {
    render(() => (
      <>
        <MenuHarness groups={[[item("reply", "Reply")]]} />
        <p>Outside</p>
      </>
    ));
    const trigger = screen.getByRole("button", { name: "More" });
    click(trigger);
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    click(trigger);
    press("Tab");
    expect(screen.queryByRole("menu")).toBeNull();
    click(trigger);
    click(screen.getByText("Outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("skips disabled items and marks checked ones", async () => {
    const run = vi.fn();
    render(() => (
      <MenuHarness
        groups={[
          [
            item("a", "Last message", vi.fn(), { checked: true }),
            item("b", "Archived", run, { disabled: true }),
            item("c", "Name", vi.fn(), { checked: false }),
          ],
        ]}
      />
    ));
    click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Last message" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    press("ArrowDown");
    expect(screen.getByRole("menuitemcheckbox", { name: "Name" })).toHaveFocus();
    click(screen.getByRole("menuitem", { name: "Archived" }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("nested overlays", () => {
  it("closes only the newest overlay on Escape", () => {
    function Nested() {
      const [outer, setOuter] = createSignal<HTMLElement>();
      const [inner, setInner] = createSignal<HTMLElement>();
      return (
        <>
          <button type="button" onClick={(event) => setOuter(event.currentTarget)}>
            Share
          </button>
          <Show when={outer()}>
            {(anchor) => (
              <Popover anchor={anchor()} label="Share" onClose={() => setOuter()}>
                <button type="button" onClick={(event) => setInner(event.currentTarget)}>
                  Options
                </button>
                <Show when={inner()}>
                  {(innerAnchor) => (
                    <Menu
                      anchor={innerAnchor()}
                      label="Link options"
                      groups={[[item("copy", "Copy link")]]}
                      onClose={() => setInner()}
                    />
                  )}
                </Show>
              </Popover>
            )}
          </Show>
        </>
      );
    }
    render(() => <Nested />);
    click(screen.getByRole("button", { name: "Share" }));
    click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByRole("menu", { name: "Link options" })).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Share" })).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes a dialog opened from a menu first and then returns focus to the menu's trigger", async () => {
    function MenuThenDialog() {
      const [anchor, setAnchor] = createSignal<HTMLElement>();
      const [confirming, setConfirming] = createSignal(false);
      return (
        <>
          <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
            More
          </button>
          <Show when={anchor()}>
            {(element) => (
              <Menu
                anchor={element()}
                label="Agent actions"
                groups={[
                  [
                    item(
                      "delete",
                      "Delete",
                      vi.fn(() => setConfirming(true)),
                    ),
                  ],
                ]}
                onClose={() => setAnchor()}
              />
            )}
          </Show>
          <Show when={confirming()}>
            <ConfirmDialog
              title="Delete Ada?"
              body="Her chats are deleted too."
              confirmLabel="Delete agent"
              danger
              onConfirm={() => setConfirming(false)}
              onCancel={() => setConfirming(false)}
            />
          </Show>
        </>
      );
    }
    render(() => <MenuThenDialog />);
    const trigger = screen.getByRole("button", { name: "More" });
    click(trigger);
    click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Ada?" });
    expect(dialog).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Select", () => {
  const options = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ] as const;

  it("opens on the selected option, picks with the keyboard and returns focus", async () => {
    const onChange = vi.fn();
    render(() => (
      <Select label="Reasoning" value="medium" options={[...options]} onChange={onChange} />
    ));
    const trigger = screen.getByRole("button", { name: "Reasoning: Medium" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    trigger.focus();
    press("ArrowDown");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByRole("option", { name: "Medium" })).toHaveFocus());
    press("ArrowDown");
    press("Enter");
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes on Escape without changing the value", async () => {
    const onChange = vi.fn();
    render(() => (
      <Select label="Reasoning" value="low" options={[...options]} onChange={onChange} />
    ));
    click(screen.getByRole("button", { name: "Reasoning: Low" }));
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when its trigger is pressed again", () => {
    render(() => (
      <Select label="Reasoning" value="low" options={[...options]} onChange={vi.fn()} />
    ));
    const trigger = screen.getByRole("button", { name: "Reasoning: Low" });
    click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps focus on the same row when its options are rebuilt", async () => {
    const [extra, setExtra] = createSignal("");
    render(() => (
      <Select
        label="Reasoning"
        value="low"
        options={options.map((option) => ({ ...option, label: option.label + extra() }))}
        onChange={vi.fn()}
      />
    ));
    click(screen.getByRole("button", { name: "Reasoning: Low" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Low" })).toHaveFocus());
    press("ArrowDown");
    setExtra("!");
    expect(screen.getByRole("option", { name: "Medium!" })).toHaveFocus();
  });

  it("closes and ignores choices once it is disabled", () => {
    const onChange = vi.fn();
    const [disabled, setDisabled] = createSignal(false);
    render(() => (
      <Combobox
        label="Model"
        searchLabel="Search models"
        emptyLabel="No models match"
        value="low"
        options={[...options]}
        disabled={disabled()}
        onChange={onChange}
      />
    ));
    click(screen.getByRole("button", { name: "Model: Low" }));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    setDisabled(true);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Combobox", () => {
  const models = [
    { value: "sonnet", label: "Sonnet 5.5", group: "Anthropic" },
    { value: "opus", label: "Opus 5.5", group: "Anthropic" },
    { value: "gpt", label: "GPT-5.5", group: "OpenAI" },
  ];

  it("filters as you type, moves with arrows and picks with Enter", async () => {
    const onChange = vi.fn();
    render(() => (
      <Combobox
        label="Model"
        searchLabel="Search models"
        emptyLabel="No models match"
        value="sonnet"
        options={models}
        onChange={onChange}
      />
    ));
    const trigger = screen.getByRole("button", { name: "Model: Sonnet 5.5" });
    click(trigger);
    const input = screen.getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("group", { name: "Anthropic" })).toBeInTheDocument();
    typeInto(screen.getByRole("combobox") as HTMLInputElement, "5.5");
    press("ArrowDown");
    const active = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active ?? "")).toHaveTextContent("Opus 5.5");
    press("Enter");
    expect(onChange).toHaveBeenCalledWith("opus");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("matches the group name and shows the empty state", async () => {
    render(() => (
      <Combobox
        label="Model"
        searchLabel="Search models"
        emptyLabel="No models match"
        value={null}
        placeholder="Choose a model"
        options={models}
        onChange={vi.fn()}
      />
    ));
    click(screen.getByRole("button", { name: "Model: Choose a model" }));
    typeInto(screen.getByRole("combobox") as HTMLInputElement, "openai");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["GPT-5.5"]);
    typeInto(screen.getByRole("combobox") as HTMLInputElement, "gpt-9");
    expect(screen.getByRole("status")).toHaveTextContent("No models match");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("Combobox with unavailable options", () => {
  it("shows them disabled with their detail and skips them with the arrow keys", async () => {
    const onChange = vi.fn();
    render(() => (
      <Combobox
        label="Model"
        searchLabel="Search models"
        emptyLabel="No models match"
        value="sonnet"
        options={[
          { value: "sonnet", label: "Sonnet 5.5", group: "Anthropic", detail: "default" },
          { value: "gpt", label: "GPT-5.5", group: "OpenAI · Sign in required", disabled: true },
          { value: "opus", label: "Opus 5.5", group: "Anthropic 2" },
        ]}
        onChange={onChange}
      />
    ));
    click(screen.getByRole("button", { name: "Model: Sonnet 5.5" }));
    const gpt = screen.getByRole("option", { name: "GPT-5.5" });
    expect(gpt).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /Sonnet 5.5/ })).toHaveTextContent("default");
    press("ArrowDown");
    const input = screen.getByRole("combobox");
    const active = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active ?? "")).toHaveTextContent("Opus 5.5");
    fireEvent.click(gpt);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  function Harness(props: {
    onConfirm: () => void;
    busy?: boolean;
    error?: string;
    typed?: string;
  }) {
    const [open, setOpen] = createSignal(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Delete
        </button>
        <Show when={open()}>
          <ConfirmDialog
            title="Delete Ada?"
            body="Removes the agent and its queue."
            confirmLabel="Delete agent"
            busyLabel="Deleting…"
            danger
            busy={props.busy}
            error={props.error}
            typedConfirmation={props.typed}
            onConfirm={props.onConfirm}
            onCancel={() => setOpen(false)}
          />
        </Show>
      </>
    );
  }

  it("is named by its title, starts on Cancel, traps Tab and returns focus", async () => {
    const onConfirm = vi.fn();
    render(() => <Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Delete" });
    click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Delete Ada?" });
    expect(dialog).toHaveAccessibleDescription("Removes the agent and its queue.");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Shift-Tab from the first button wraps to the last, Tab from the last wraps to the first.
    press("Tab", { shiftKey: true });
    expect(screen.getByRole("button", { name: "Delete agent" })).toHaveFocus();
    press("Tab");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    screen.getByRole("button", { name: "Delete agent" }).focus();
    press("Enter");
    expect(onConfirm).toHaveBeenCalledOnce();
    press("Escape");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("can't be closed while busy and shows the busy label", async () => {
    render(() => <Harness onConfirm={vi.fn()} busy />);
    click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    press("Escape");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("shows the error and offers Try again", async () => {
    render(() => (
      <Harness onConfirm={vi.fn()} error="Couldn't delete Ada. Stop its task, then try again." />
    ));
    click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't delete Ada.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("waits for the typed confirmation", async () => {
    render(() => <Harness onConfirm={vi.fn()} typed="Ada" />);
    click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete agent" });
    expect(confirm).toBeDisabled();
    typeInto(
      screen.getByRole("textbox", { name: "Type “Ada” to confirm" }) as HTMLInputElement,
      "Ada",
    );
    expect(confirm).toBeEnabled();
  });
});

describe("Toast", () => {
  it("announces the message, runs the action and hides after its duration", async () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(() => <ToastRegion />);
    showToast({ message: "Ada archived", action: { label: "Undo", run: undo } });
    expect(await screen.findByRole("status")).toHaveTextContent("Ada archived");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    showToast({ message: "Copied" });
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    vi.advanceTimersByTime(4000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays while the pointer is on it", () => {
    vi.useFakeTimers();
    render(() => <ToastRegion />);
    showToast({ message: "Copied" });
    const region = screen.getByRole("region", { name: "Notifications" });
    fireEvent.pointerEnter(region);
    vi.advanceTimersByTime(10_000);
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    fireEvent.pointerLeave(region);
    vi.advanceTimersByTime(4000);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Tooltip", () => {
  it("shows after a hover delay, describes the control and hides on Escape", async () => {
    vi.useFakeTimers();
    render(() => (
      <Tooltip label="Copy message">
        <button type="button" aria-label="Copy">
          ⧉
        </button>
      </Tooltip>
    ));
    const button = screen.getByRole("button", { name: "Copy" });
    fireEvent.pointerEnter(button.parentElement as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy message");
    expect(button).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
  });
});
