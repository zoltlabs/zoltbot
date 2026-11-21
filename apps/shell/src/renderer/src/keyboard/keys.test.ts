import { describe, expect, it } from "vitest";
import { conflictFor, displayKeys, keysFromEvent, type ListedShortcut } from "./keys";

const press = (patch: Partial<KeyboardEvent>) =>
  ({
    key: "t",
    code: "KeyT",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...patch,
  }) as KeyboardEvent;

describe("keyboard keys", () => {
  it("turns a press into keys, and ignores bare keys and lone modifiers", () => {
    expect(keysFromEvent(press({ metaKey: true, shiftKey: true }), true)).toBe("Mod+Shift+T");
    expect(keysFromEvent(press({ ctrlKey: true }), false)).toBe("Mod+T");
    expect(keysFromEvent(press({ ctrlKey: true }), true)).toBe("Ctrl+T");
    // Option changes the character, not the physical key.
    expect(keysFromEvent(press({ altKey: true, key: "†" }), true)).toBe("Alt+T");
    expect(keysFromEvent(press({}), true)).toBeNull();
    expect(keysFromEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), true)).toBeNull();
  });

  it("names the command that already has the keys", () => {
    const list: ListedShortcut[] = [
      { id: "a", label: "New chat", keys: "Mod+N", when: "global" },
      { id: "b", label: "Send", keys: "Mod+Enter", when: "composer" },
      { id: "c", label: "Bold", keys: "Mod+B", when: "editor" },
    ];
    expect(conflictFor("b", "Mod+N", list)).toBe("New chat");
    // Composer and editor keys don't reach each other.
    expect(conflictFor("b", "Mod+B", list)).toBeUndefined();
    expect(conflictFor("a", "Mod+K", list)).toBe("Command palette");
    expect(conflictFor("a", "Mod+N", list)).toBeUndefined();
    // Tasks owns Mod+T: setting it back isn't a clash.
    const tasks = [
      { id: "t", label: "Tasks", keys: "Mod+Y", when: "global", defaultKeys: "Mod+T" } as const,
    ];
    expect(conflictFor("t", "Mod+T", tasks)).toBeUndefined();
  });

  it("records the key the matcher reads, on any layout", () => {
    // Shift+1 types "!": that is what the shortcut later sees.
    expect(
      keysFromEvent(press({ metaKey: true, shiftKey: true, key: "!", code: "Digit1" }), true),
    ).toBe("Mod+Shift+!");
    // On AZERTY the key labelled A sends code KeyQ and key "a".
    expect(keysFromEvent(press({ metaKey: true, key: "a", code: "KeyQ" }), true)).toBe("Mod+A");
    expect(keysFromEvent(press({ metaKey: true, key: "+", code: "Equal" }), true)).toBeNull();
  });

  it("keeps system keys, and reads Ctrl as Mod off a Mac", () => {
    const list: ListedShortcut[] = [{ id: "a", label: "Tasks", keys: "Mod+T", when: "global" }];
    expect(conflictFor("b", "Mod+C", list)).toBe("system");
    expect(conflictFor("b", "Alt+F4", list, false)).toBe("system");
    expect(conflictFor("b", "Ctrl+T", list, true)).toBeUndefined();
    expect(conflictFor("b", "Ctrl+T", list, false)).toBe("Tasks");
    expect(displayKeys("Mod+Ctrl+T", false)).toBe("Ctrl+T");
  });

  it("shows keys the way each system writes them", () => {
    expect(displayKeys("Shift+Mod+T", true)).toBe("⇧⌘T");
    expect(displayKeys("Mod+Shift+T", false)).toBe("Ctrl+Shift+T");
  });
});
