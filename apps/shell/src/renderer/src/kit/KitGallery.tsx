// Test-only page with every kit component, loaded with `index.html?kit-gallery`.
// The headless design checks open each overlay here, including triggers at
// every window edge and inside a clipped scrolling panel.
import { createSignal, For, type JSX, Show } from "solid-js";
import {
  type Anchor,
  Combobox,
  ConfirmDialog,
  EmptyState,
  Field,
  Menu,
  type MenuItem,
  ModelLogo,
  Popover,
  Select,
  SettingsRow,
  Stack,
  showToast,
  ToastRegion,
  Tooltip,
} from ".";

const noop = () => undefined;
const MENU: MenuItem[][] = [
  [
    { id: "reply", label: "Reply", run: noop },
    { id: "copy", label: "Copy", run: noop, shortcut: "⌘C" },
  ],
  [
    { id: "pin", label: "Pin", run: noop },
    { id: "branch", label: "Branch from here", run: noop },
    { id: "edit", label: "Edit", run: noop },
  ],
  [{ id: "read", label: "Read aloud", run: noop }],
  [{ id: "hide", label: "Hide", run: noop, danger: true }],
];

const MODELS = [
  { id: "sonnet", name: "Sonnet 5.5", provider: "claude", group: "Anthropic" },
  { id: "opus", name: "Opus 5.5", provider: "claude", group: "Anthropic" },
  { id: "gpt", name: "GPT-5.5", provider: "codex", group: "OpenAI" },
  { id: "deepseek", name: "DeepSeek V4.5", provider: "openrouter", group: "OpenRouter" },
].map((model) => ({
  value: model.id,
  label: model.name,
  group: model.group,
  icon: () => <ModelLogo model={model} />,
}));

const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function MenuButton(props: { id: string; label: string; style?: JSX.CSSProperties }) {
  const [anchor, setAnchor] = createSignal<Anchor>();
  return (
    <>
      <button
        type="button"
        id={props.id}
        class="zb-kit-button"
        style={props.style}
        aria-haspopup="menu"
        aria-expanded={anchor() !== undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        {props.label}
      </button>
      <Show when={anchor()}>
        {(value) => (
          <Menu
            anchor={value()}
            label="Message actions"
            groups={MENU}
            onClose={() => setAnchor()}
          />
        )}
      </Show>
    </>
  );
}

export function KitGallery() {
  const [model, setModel] = createSignal("sonnet");
  const [effort, setEffort] = createSignal("medium");
  const [popover, setPopover] = createSignal<HTMLElement>();
  const [confirm, setConfirm] = createSignal(false);
  const [point, setPoint] = createSignal<Anchor>();
  const edge = (style: JSX.CSSProperties): JSX.CSSProperties => ({ position: "fixed", ...style });
  return (
    <main
      class="zb-kit-gallery"
      style={{
        height: "100vh",
        overflow: "auto",
        padding: "56px 120px",
        background: "var(--background)",
        color: "var(--text-primary)",
      }}
    >
      <h1 style={{ "font-size": "16px", margin: "0 0 16px" }}>Kit gallery</h1>
      <MenuButton id="menu-top-left" label="Top left" style={edge({ top: "4px", left: "4px" })} />
      <MenuButton
        id="menu-top-right"
        label="Top right"
        style={edge({ top: "4px", right: "4px" })}
      />
      <MenuButton
        id="menu-bottom-left"
        label="Bottom left"
        style={edge({ bottom: "4px", left: "4px" })}
      />
      <MenuButton
        id="menu-bottom-right"
        label="Bottom right"
        style={edge({ bottom: "4px", right: "4px" })}
      />
      <Stack gap={4}>
        <section
          aria-label="Clipped panel"
          style={{
            height: "72px",
            overflow: "hidden",
            border: "1px solid var(--openbot-line)",
            "border-radius": "12px",
            padding: "8px 12px",
          }}
        >
          <div style={{ height: "160px", overflow: "auto" }}>
            <SettingsRow
              label="Reasoning"
              control={() => (
                <Select label="Reasoning" value={effort()} options={EFFORTS} onChange={setEffort} />
              )}
            />
            <SettingsRow
              label="Model"
              control={() => (
                <Combobox
                  label="Model"
                  searchLabel="Search models"
                  emptyLabel="No models match"
                  value={model()}
                  options={MODELS}
                  onChange={setModel}
                />
              )}
            />
          </div>
        </section>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <button
            type="button"
            id="open-popover"
            class="zb-kit-button"
            aria-haspopup="dialog"
            onClick={(event) => setPopover(event.currentTarget)}
          >
            Popover
          </button>
          <Show when={popover()}>
            {(anchor) => (
              <Popover anchor={anchor()} label="Share" onClose={() => setPopover()} width={240}>
                <Field
                  label="Link"
                  input={(id, describedBy) => (
                    <input
                      id={id}
                      class="zb-kit-input"
                      aria-describedby={describedBy}
                      value="https://example.com/a1"
                      readOnly
                    />
                  )}
                />
              </Popover>
            )}
          </Show>
          <button
            type="button"
            id="open-confirm"
            class="zb-kit-button"
            aria-haspopup="dialog"
            onClick={() => setConfirm(true)}
          >
            Delete agent
          </button>
          <Show when={confirm()}>
            <ConfirmDialog
              title="Delete Ada?"
              body="Removes the agent, its queue and the files only this chat used. Its workspace and history stay on your Mac."
              confirmLabel="Delete agent"
              danger
              onConfirm={() => setConfirm(false)}
              onCancel={() => setConfirm(false)}
            />
          </Show>
          <button
            type="button"
            id="show-toast"
            class="zb-kit-button"
            onClick={() =>
              showToast({ message: "Ada archived", action: { label: "Undo", run: noop } })
            }
          >
            Archive
          </button>
          <Tooltip label="Copy message">
            <button type="button" id="tooltip-trigger" class="zb-kit-button" aria-label="Copy">
              ⧉
            </button>
          </Tooltip>
          <button
            type="button"
            id="context-corner"
            class="zb-kit-button"
            aria-haspopup="menu"
            onClick={() => setPoint({ x: window.innerWidth - 2, y: window.innerHeight - 2 })}
          >
            Right-click in the corner
          </button>
          <Show when={point()}>
            {(value) => (
              <Menu
                anchor={value()}
                label="Message actions"
                groups={MENU}
                onClose={() => setPoint()}
              />
            )}
          </Show>
        </div>
        <EmptyState
          level={2}
          title="No coding tools set up"
          action={
            <button type="button" class="zb-kit-button primary">
              Add an agent
            </button>
          }
        />
        <For each={[1, 2, 3]}>
          {(index) => <p style={{ margin: 0, color: "var(--text-secondary)" }}>Row {index}</p>}
        </For>
      </Stack>
      <ToastRegion />
    </main>
  );
}
