// Test-only pages, each broken in one way, loaded with `index.html?design-fixture=<name>`.
// The headless design checks must report a problem on every page except "clean".
import { createSignal, type JSX, Show } from "solid-js";

function FakeOverlay(props: { style: JSX.CSSProperties; children?: JSX.Element }) {
  return (
    <div
      data-kit-overlay="menu"
      role="menu"
      aria-label="Fixture menu"
      style={{
        position: "fixed",
        width: "200px",
        height: "120px",
        background: "var(--surface-popover, #333)",
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

const FIXTURES: Record<string, () => JSX.Element> = {
  clean: () => (
    <button type="button" style={{ width: "120px", height: "32px" }}>
      Save
    </button>
  ),
  "clipped-menu": () => {
    const [open, setOpen] = createSignal(false);
    return (
      <>
        <button type="button" aria-haspopup="menu" onClick={() => setOpen(true)}>
          Open menu
        </button>
        <Show when={open()}>
          <FakeOverlay style={{ left: "calc(100vw - 80px)", top: "40px" }} />
        </Show>
      </>
    );
  },
  "covered-popover": () => (
    <>
      <FakeOverlay style={{ left: "40px", top: "40px" }} />
      <div
        style={{
          position: "fixed",
          left: "100px",
          top: "80px",
          width: "60px",
          height: "60px",
          "z-index": 10,
          background: "red",
        }}
      />
    </>
  ),
  "horizontal-overflow": () => <div style={{ width: "3000px", height: "20px" }} />,
  "truncated-text": () => (
    <p
      style={{
        width: "80px",
        overflow: "hidden",
        "white-space": "nowrap",
        "text-overflow": "ellipsis",
      }}
    >
      A sentence far too long to fit in its box
    </p>
  ),
  "small-target": () => (
    <button
      type="button"
      aria-label="Close"
      style={{ width: "16px", height: "16px", padding: 0 }}
    />
  ),
  "overlapping-controls": () => (
    <div style={{ display: "flex" }}>
      <button type="button" style={{ width: "100px", height: "32px" }}>
        First
      </button>
      <button type="button" style={{ width: "100px", height: "32px", "margin-left": "-50px" }}>
        Second
      </button>
    </div>
  ),
};

export const DESIGN_FIXTURES = Object.keys(FIXTURES);

export function DesignFixture(props: { name: string }) {
  const fixture = FIXTURES[props.name];
  return (
    <main style={{ padding: "16px" }}>
      <h1>Design fixture</h1>
      {fixture ? fixture() : <p>Unknown fixture</p>}
    </main>
  );
}
