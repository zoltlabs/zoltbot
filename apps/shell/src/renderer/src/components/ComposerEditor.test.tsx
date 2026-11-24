import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SlashCommand } from "../../../shared/ipc";
import { ComposerEditor, matchCommands } from "./ComposerEditor";

function renderComposer(commands?: SlashCommand[]) {
  const onSubmit = vi.fn();
  const onValueChange = vi.fn();

  render(() => {
    const [value, setValue] = createSignal("");
    return (
      <ComposerEditor
        botId="chief"
        bots={[]}
        {...(commands ? { commands } : {})}
        value={value()}
        placeholder="Message Chief"
        ariaLabel="Message Chief"
        disabled={false}
        onValueChange={(nextValue) => {
          onValueChange(nextValue);
          setValue(nextValue);
        }}
        onSubmit={onSubmit}
      />
    );
  });

  return {
    editor: screen.getByRole("textbox", { name: "Message Chief" }),
    onSubmit,
    onValueChange,
  };
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("ComposerEditor", () => {
  it("keeps repeated Shift+Enter line breaks in the draft", async () => {
    const { editor, onSubmit, onValueChange } = renderComposer();
    editor.textContent = "First line";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    placeCaretAtEnd(editor);
    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).toHaveBeenLastCalledWith("First line\n\n");
    expect(editor.textContent).toBe("First line\n\n");
  });

  it("submits with Enter without changing the multiline draft", async () => {
    const { editor, onSubmit, onValueChange } = renderComposer();
    editor.textContent = "First line\nSecond line";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    await fireEvent.keyDown(editor, { key: "Enter" });

    expect(onValueChange).toHaveBeenLastCalledWith("First line\nSecond line");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(editor.textContent).toBe("First line\nSecond line");
  });

  it("does not submit when Enter confirms IME composition", async () => {
    const { editor, onSubmit } = renderComposer();

    await fireEvent.compositionStart(editor);
    await fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.compositionEnd(editor);
    await fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("preserves multiline plain text when pasted", async () => {
    const { editor, onValueChange } = renderComposer();
    placeCaretAtEnd(editor);

    await fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => "First line\r\nSecond line\rThird line",
      },
    });

    expect(onValueChange).toHaveBeenLastCalledWith("First line\nSecond line\nThird line");
    expect(editor.textContent).toBe("First line\nSecond line\nThird line");
  });

  describe("/ menu", () => {
    const commands: SlashCommand[] = [
      { name: "compact", description: "Summarize the chat so far" },
      { name: "clear", description: "Start over" },
      { name: "review", argumentHint: "[pr]" },
    ];

    async function typeText(editor: HTMLElement, text: string) {
      editor.textContent = text;
      placeCaretAtEnd(editor);
      await fireEvent.input(editor);
    }

    it("lists the session's commands when the message starts with /", async () => {
      const { editor } = renderComposer(commands);
      await typeText(editor, "/");
      const list = await screen.findByRole("listbox", { name: "Commands" });
      expect(list.querySelectorAll("[role=option]")).toHaveLength(3);
      expect(list.textContent).toContain("Summarize the chat so far");
    });

    it("filters by what follows the / and inserts the chosen command", async () => {
      const { editor, onSubmit, onValueChange } = renderComposer(commands);
      await typeText(editor, "/cl");
      const options = await screen.findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual(["/clearStart over"]);
      await fireEvent.keyDown(editor, { key: "Enter" });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onValueChange).toHaveBeenLastCalledWith("/clear ");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("sends a command typed out in full on Enter", async () => {
      const { editor, onSubmit } = renderComposer(commands);
      await typeText(editor, "/clear");
      await screen.findByRole("listbox");
      await fireEvent.keyDown(editor, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("moves through the list with the arrow keys", async () => {
      const { editor, onValueChange } = renderComposer(commands);
      await typeText(editor, "/");
      await fireEvent.keyDown(editor, { key: "ArrowDown" });
      await fireEvent.keyDown(editor, { key: "Tab" });
      expect(onValueChange).toHaveBeenLastCalledWith("/clear ");
    });

    it("says so when the session reported no commands", async () => {
      const { editor } = renderComposer();
      await typeText(editor, "/");
      expect((await screen.findByRole("status")).textContent).toBe("No commands available");
    });

    it("stays closed for a path or a / later in the message", async () => {
      const { editor } = renderComposer(commands);
      await typeText(editor, "/usr/local");
      expect(screen.queryByRole("listbox")).toBeNull();
      await typeText(editor, "try /clear");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("ranks names that start with the query first", () => {
      expect(matchCommands(commands, "c").map((command) => command.name)).toEqual([
        "compact",
        "clear",
      ]);
      expect(matchCommands(commands, "r").map((command) => command.name)).toEqual([
        "review",
        "clear",
      ]);
    });
  });
});
