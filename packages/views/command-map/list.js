// The chat list: every chat on the map, with its state in words. It is the keyboard and
// screen-reader path to everything the map shows, so it never depends on the canvas.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const order = { needs_you: 0, working: 2, review: 3, idle: 4 };

  map.ChatList = class {
    // host: { selected(): Set, select(ids), find(id), open(id) }
    constructor(host) {
      this.host = host;
      this.container = document.querySelector("#chats");
      this.empty = document.querySelector("#empty");
      this.signature = "";
    }
    render(units) {
      const selected = this.host.selected();
      const chats = units
        .map(({ chat }) => ({ chat, ...map.unitState(chat) }))
        .sort(
          (a, b) =>
            (a.problem && a.state !== "needs_you" ? 1 : order[a.state]) -
              (b.problem && b.state !== "needs_you" ? 1 : order[b.state]) ||
            a.chat.title.localeCompare(b.chat.title),
        );
      const signature = JSON.stringify(
        chats.map(({ chat, problem }) => [
          chat.id,
          chat.title,
          chat.status,
          problem,
          chat.profile.name,
          chat.provider.name,
          chat.activity,
          selected.has(chat.id),
        ]),
      );
      if (signature === this.signature) return;
      this.signature = signature;
      this.empty.hidden = chats.length > 0;
      const focusId = document.activeElement?.dataset?.focusId;
      this.container.replaceChildren(
        ...chats.map(({ chat, problem }) => {
          const checkbox = el("input", { type: "checkbox", "data-focus-id": `select-${chat.id}` });
          checkbox.checked = selected.has(chat.id);
          checkbox.onchange = () => {
            const next = new Set(this.host.selected());
            if (checkbox.checked) next.add(chat.id);
            else next.delete(chat.id);
            this.host.select([...next]);
          };
          const action = (name, run) => {
            const button = el(
              "button",
              {
                type: "button",
                "aria-label": `${name}: ${chat.title}`,
                "data-focus-id": `${name}-${chat.id}`,
              },
              name,
            );
            button.onclick = run;
            return button;
          };
          return el(
            "li",
            {
              class: selected.has(chat.id) ? "selected" : "",
              "data-state": map.unitState(chat).state,
            },
            el(
              "label",
              {},
              checkbox,
              map.stateIcon(chat),
              `${chat.title} — ${map.statusLabels[chat.status]}${problem ? " ⚠ Warning" : ""}`,
            ),
            el(
              "p",
              {},
              `${chat.profile.name} · ${chat.provider.name}${chat.activity ? ` · ${chat.activity}` : ""}`,
            ),
            el(
              "div",
              { class: "row" },
              action("Find on map", () => this.host.find(chat.id)),
              action("Open chat", () => this.host.open(chat.id)),
            ),
          );
        }),
      );
      if (focusId)
        for (const element of this.container.querySelectorAll("[data-focus-id]"))
          if (element.dataset.focusId === focusId) element.focus({ preventScroll: true });
    }
  };
})();
