import type { NativeCommand } from "@zoltbot/protocol";
export function CommandPicker({
  commands,
  query,
  id,
  onPick,
  onDismiss,
}: {
  commands: NativeCommand[] | undefined;
  query: string;
  id: string;
  onPick(command: NativeCommand): void;
  onDismiss(): void;
}) {
  const filtered =
    commands
      ?.filter((command) => command.name.toLowerCase().includes(query.toLowerCase()))
      .sort(
        (a, b) => Number(a.name.startsWith("zoltbot-")) - Number(b.name.startsWith("zoltbot-")),
      ) ?? [];
  return (
    <section
      id={id}
      className="chat-mentions"
      aria-label="Native commands"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-picker-option]"),
        ];
        if (!buttons.length) return;
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        event.preventDefault();
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }}
    >
      <div className="r">
        <strong>Native commands</strong>
        <span className="sp" />
        <button
          type="button"
          className="btn sm"
          aria-label="Close command picker"
          onClick={onDismiss}
        >
          Close
        </button>
      </div>
      {filtered.length ? (
        <ul>
          {filtered.slice(0, 20).map((command, index, all) => (
            <li key={`${command.name}-group`} style={{ listStyle: "none" }}>
              {(index === 0 ||
                command.name.startsWith("zoltbot-") !==
                  all[index - 1]?.name.startsWith("zoltbot-")) && (
                <p className="dim sm">
                  {command.name.startsWith("zoltbot-")
                    ? "Skills · reported loaded natively"
                    : "Provider commands"}
                </p>
              )}
              <ul>
                <li key={command.name}>
                  <button type="button" data-picker-option onClick={() => onPick(command)}>
                    <strong className="mono">/{command.name}</strong>
                    {command.argumentHint ? (
                      <span className="chat-command-hint">{command.argumentHint}</span>
                    ) : null}
                    {command.description ? (
                      <p className="chat-command-description">{command.description}</p>
                    ) : null}
                  </button>
                </li>
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <output>
          {commands
            ? "No matching reported commands."
            : "No native command catalog is available for this session."}
        </output>
      )}
      {filtered.length > 20 ? (
        <p className="dim sm">Showing twenty reported commands. Type more to narrow the list.</p>
      ) : null}
    </section>
  );
}
