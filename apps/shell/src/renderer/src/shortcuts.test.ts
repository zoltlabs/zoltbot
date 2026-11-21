import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextsFor,
  createShortcutRegistry,
  matchesKeys,
  normalizeKeys,
  RESERVED_KEYS,
} from "./shortcuts";

afterEach(() => {
  document.body.innerHTML = "";
});

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("shortcut keys", () => {
  it("maps Mod to Command on the Mac and Control elsewhere", () => {
    const mac = new KeyboardEvent("keydown", { key: "t", metaKey: true });
    const pc = new KeyboardEvent("keydown", { key: "t", ctrlKey: true });
    expect(matchesKeys(mac, "Mod+T", true)).toBe(true);
    expect(matchesKeys(pc, "Mod+T", true)).toBe(false);
    expect(matchesKeys(pc, "Mod+T", false)).toBe(true);
    expect(matchesKeys(new KeyboardEvent("keydown", { key: "t" }), "Mod+T", true)).toBe(false);
  });

  it("matches Alt combinations by the physical key", () => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", altKey: true });
    expect(matchesKeys(event, "Alt+Space", true)).toBe(true);
    const letter = new KeyboardEvent("keydown", { key: "∂", code: "KeyD", altKey: true });
    expect(matchesKeys(letter, "Alt+D", true)).toBe(true);
  });

  it("normalizes the order of modifiers", () => {
    expect(normalizeKeys("Shift+Mod+d")).toBe("Mod+Shift+D");
    expect(normalizeKeys("Alt+space")).toBe("Alt+Space");
    expect(() => normalizeKeys("Hyper+K")).toThrow("Unknown modifier");
  });

  it("lists the writing-mode keys as reserved", () => {
    for (const keys of ["Mod+J", "Mod+P", "Mod+Shift+D", "Alt+Space", "Mod+K"])
      expect(RESERVED_KEYS[keys]).toBeDefined();
  });
});

describe("shortcut contexts", () => {
  it("finds the contexts from the target outwards, most specific first", () => {
    document.body.innerHTML = `
      <section data-shortcut-context="chat">
        <div data-shortcut-context="composer"><textarea></textarea></div>
        <div role="menu"><button>Pin</button></div>
      </section>`;
    expect(contextsFor(document.querySelector("textarea"))).toEqual(["composer", "chat", "global"]);
    expect(contextsFor(document.querySelector("button"))).toEqual(["overlay", "chat", "global"]);
    expect(contextsFor(document.body)).toEqual(["global"]);
  });
});

describe("shortcut registry", () => {
  it("runs the most specific match and prevents the default action", () => {
    document.body.innerHTML = `<div data-shortcut-context="composer"><textarea></textarea></div>`;
    const registry = createShortcutRegistry({ isMac: true });
    const global = vi.fn();
    const composer = vi.fn();
    registry.register({ id: "a", keys: "Escape", when: "global", label: "Close", run: global });
    registry.register({ id: "b", keys: "Escape", when: "composer", label: "Clear", run: composer });
    const event = press(document.querySelector("textarea") as Element, { key: "Escape" });
    expect(registry.handle(event)).toBe(true);
    expect(composer).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls through when a handler returns false", () => {
    const registry = createShortcutRegistry({ isMac: true });
    const global = vi.fn();
    registry.register({ id: "a", keys: "Escape", when: "global", label: "Close", run: global });
    registry.register({
      id: "b",
      keys: "Escape",
      when: "chat",
      label: "Close menu",
      run: () => false,
    });
    document.body.innerHTML = `<div data-shortcut-context="chat"><p>hi</p></div>`;
    registry.handle(press(document.querySelector("p") as Element, { key: "Escape" }));
    expect(global).toHaveBeenCalledOnce();
  });

  it("ignores events during IME composition or already handled", () => {
    const registry = createShortcutRegistry({ isMac: true });
    const run = vi.fn();
    registry.register({ id: "a", keys: "Enter", when: "global", label: "Send", run });
    expect(registry.handle(press(document.body, { key: "Enter", isComposing: true }))).toBe(false);
    const handled = press(document.body, { key: "Enter" });
    handled.preventDefault();
    expect(registry.handle(handled)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects two shortcuts with the same keys in one context", () => {
    const registry = createShortcutRegistry({ isMac: true });
    registry.register({ id: "a", keys: "Mod+T", when: "global", label: "Tasks", run: vi.fn() });
    expect(() =>
      registry.register({ id: "b", keys: "Mod+t", when: "global", label: "Other", run: vi.fn() }),
    ).toThrow("both use Mod+T");
    expect(() =>
      registry.register({ id: "a", keys: "Mod+U", when: "chat", label: "Again", run: vi.fn() }),
    ).toThrow("already registered");
  });

  it("still registers a shortcut whose default an owner's binding took", () => {
    const registry = createShortcutRegistry({ isMac: true });
    registry.setBindings({ a: "Mod+E" });
    registry.register({ id: "a", keys: "Mod+U", when: "composer", label: "One", run: vi.fn() });
    expect(() =>
      registry.register({ id: "b", keys: "Mod+E", when: "composer", label: "Two", run: vi.fn() }),
    ).not.toThrow();
  });

  it("uses owner bindings and unregisters", () => {
    const registry = createShortcutRegistry({ isMac: true });
    const run = vi.fn();
    const remove = registry.register({
      id: "tasks",
      keys: "Mod+T",
      when: "global",
      label: "Tasks",
      run,
    });
    registry.setBindings({ tasks: "Mod+Shift+T" });
    expect(registry.keysFor("tasks")).toBe("Mod+Shift+T");
    expect(registry.handle(press(document.body, { key: "t", metaKey: true }))).toBe(false);
    expect(registry.handle(press(document.body, { key: "T", metaKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "tasks", keys: "Mod+Shift+T" }),
    ]);
    remove();
    expect(registry.list()).toEqual([]);
  });
});
