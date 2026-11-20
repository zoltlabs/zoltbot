import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type Preferences } from "../../shared/preferences";
import { installShortcuts, shortcuts } from "./app-shortcuts";

describe("app shortcuts", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const stop of cleanup.splice(0)) stop();
    shortcuts.setBindings({});
  });

  it("dispatches keydown from the window and follows rebound keys in preferences", async () => {
    let changed: ((preferences: Preferences) => void) | undefined;
    const saved = { ...DEFAULT_PREFERENCES, keyBindings: { "test.open": "Shift+O" } };
    const target = Object.assign(new EventTarget(), {
      openbot: {
        preferences: {
          get: vi.fn().mockResolvedValue(saved),
          set: vi.fn(),
          onChange: (listener: (preferences: Preferences) => void) => {
            changed = listener;
            return () => undefined;
          },
        },
      },
    }) as unknown as Window;
    const run = vi.fn();
    cleanup.push(
      shortcuts.register({ id: "test.open", keys: "O", when: "global", label: "Open", run }),
    );
    cleanup.push(installShortcuts(target));
    await vi.waitFor(() => expect(shortcuts.keysFor("test.open")).toBe("Shift+O"));

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "o" }));
    expect(run).not.toHaveBeenCalled();
    const event = new KeyboardEvent("keydown", { key: "O", shiftKey: true, cancelable: true });
    target.dispatchEvent(event);
    expect(run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);

    changed?.({ ...DEFAULT_PREFERENCES, keyBindings: {} });
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "o" }));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
