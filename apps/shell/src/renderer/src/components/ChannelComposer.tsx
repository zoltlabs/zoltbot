import { createMemo, createSignal, For, Show } from "solid-js";
import type { ChannelMember } from "../../../shared/channels";
import { insertMention, matchMembers, mentionAt } from "../channels";

interface ChannelComposerProps {
  channelName: string;
  members: ChannelMember[];
  onSend: (text: string) => Promise<boolean>;
}

/** The channel's message box. Typing @ lists the members; arrows pick one, Enter or Tab adds it. */
export function ChannelComposer(props: ChannelComposerProps) {
  const [value, setValue] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;
  const listId = `channel-mentions-${Math.random().toString(36).slice(2, 8)}`;

  const mention = createMemo(() => (dismissed() ? null : mentionAt(value(), caret())));
  const options = createMemo(() => {
    const current = mention();
    return current ? matchMembers(props.members, current.query) : [];
  });
  const open = () => options().length > 0;

  function sync() {
    if (!input) return;
    setValue(input.value);
    setCaret(input.selectionStart ?? input.value.length);
    setDismissed(false);
    setActive(0);
  }

  function pick(member: ChannelMember) {
    const current = mention();
    if (!input || !current) return;
    const next = insertMention(value(), current, member);
    input.value = next.value;
    input.setSelectionRange(next.caret, next.caret);
    setValue(next.value);
    setCaret(next.caret);
    input.focus();
  }

  async function send() {
    const text = value().trim();
    if (!text) return;
    if (input) input.value = "";
    setValue("");
    setCaret(0);
    if (!(await props.onSend(text)) && input && !input.value) {
      input.value = text;
      setValue(text);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (open()) {
      const count = options().length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const member = options()[active()];
        if (member) {
          event.preventDefault();
          pick(member);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <form
      class="channel-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Show when={open()}>
        <div id={listId} class="channel-mentions" role="listbox" aria-label="Members">
          <For each={options()}>
            {(member, index) => (
              // The input keeps focus; arrows move the active option (aria-activedescendant).
              <button
                type="button"
                tabIndex={-1}
                id={`${listId}-${index()}`}
                role="option"
                class="channel-mention-option"
                classList={{ "channel-mention-option-active": active() === index() }}
                aria-selected={active() === index()}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index())}
                onClick={() => pick(member)}
              >
                <span>{member.name}</span>
                <Show when={member.lead}>
                  <span class="channel-lead-badge">Lead</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={input}
        class="channel-composer-input"
        rows={1}
        maxLength={4000}
        aria-label={`Message #${props.channelName}`}
        aria-autocomplete="list"
        aria-controls={open() ? listId : undefined}
        aria-activedescendant={open() ? `${listId}-${active()}` : undefined}
        placeholder={`Message #${props.channelName}`}
        onInput={sync}
        onClick={sync}
        onKeyUp={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") sync();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissed(true)}
      />
      <button type="submit" class="channel-send" disabled={!value().trim()}>
        Send
      </button>
    </form>
  );
}
