// The selection panel in the middle of the console: what is selected right now.
// One chat shows its details; several show a grid of tiles, as in a strategy game.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const MAX_TILES = 18;

  map.Selection = class {
    // host: { select(ids), find(id), open(id) }
    constructor(host) {
      this.host = host;
      this.container = document.querySelector("#selection");
      this.signature = "";
    }
    render(units, selected) {
      const chosen = units.filter(({ chat }) => selected.has(chat.id)).map(({ chat }) => chat);
      const signature = JSON.stringify(
        chosen.map((chat) => [
          chat.id,
          chat.title,
          chat.status,
          chat.activity,
          map.unitState(chat).problem,
        ]),
      );
      if (signature === this.signature) return;
      this.signature = signature;
      const heading = el(
        "h2",
        {},
        chosen.length > 1 ? `${chosen.length} chats selected` : "Selection",
      );
      if (!chosen.length) {
        this.container.replaceChildren(
          heading,
          el("p", { class: "hint" }, "Drag a box on the map or tick chats in the list."),
        );
        return;
      }
      if (chosen.length === 1) {
        const [chat] = chosen,
          { state, problem } = map.unitState(chat);
        const button = (name, run) => {
          const control = el("button", { type: "button" }, name);
          control.onclick = run;
          return control;
        };
        this.container.replaceChildren(
          heading,
          el(
            "div",
            { class: "portrait", "data-state": state },
            el("span", { class: "badge" }, map.stateIcon(chat)),
            el(
              "div",
              {},
              el("h3", {}, chat.title),
              el(
                "p",
                { class: "status" },
                `${map.statusLabels[chat.status]}${problem ? " · Warning" : ""}`,
              ),
              el("p", {}, `${chat.profile.name} · ${chat.provider.name}`),
              chat.activity ? el("p", {}, chat.activity) : undefined,
            ),
          ),
          el(
            "div",
            { class: "row" },
            button("Find on map", () => this.host.find(chat.id)),
            button("Open chat", () => this.host.open(chat.id)),
          ),
        );
        return;
      }
      // Several chats: one tile each. Choosing a tile narrows the selection to that chat.
      const tiles = chosen.slice(0, MAX_TILES).map((chat) => {
        const tile = el(
          "button",
          {
            type: "button",
            class: "tile",
            "data-state": map.unitState(chat).state,
            "aria-label": `Select only ${chat.title}, ${map.statusLabels[chat.status].toLowerCase()}`,
            title: chat.title,
          },
          map.stateIcon(chat),
          el("span", {}, chat.title),
        );
        tile.onclick = () => this.host.find(chat.id);
        return tile;
      });
      this.container.replaceChildren(heading, el("div", { class: "tiles" }, ...tiles));
      if (chosen.length > MAX_TILES)
        this.container.append(
          el("p", { class: "hint" }, `And ${chosen.length - MAX_TILES} more, in the chat list.`),
        );
    }
  };
})();
