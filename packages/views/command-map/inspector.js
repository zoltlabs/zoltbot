// The panel at the bottom left of the map, like a strategy game's unit panel. It shows the
// selected chat (with its request and orders), several selected chats, or a city's chats.
(() => {
  const map = window.CommandMap,
    { el } = map;
  // A walker's head and shoulders for the portrait, in the agent's color.
  const portrait = (chat) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("aria-hidden", "true");
    const pc = map.providerColor(chat),
      visor = map.markColor(chat);
    svg.innerHTML =
      `<rect x="9" y="17" width="22" height="18" rx="4" fill="#5b606c"/>` +
      `<rect x="6" y="17" width="6" height="7" fill="${pc}"/><rect x="28" y="17" width="6" height="7" fill="${pc}"/>` +
      `<rect x="12" y="5" width="16" height="12" rx="3" fill="#6b707c"/>` +
      `<rect x="15" y="9" width="10" height="4" fill="${visor}"/>`;
    return el("div", { class: "portrait" }, svg);
  };
  map.Inspector = class {
    // host: { actions, selected(): Set, select(id, add), clear(), find(id), open(id) }
    constructor(host) {
      this.host = host;
      this.container = document.querySelector("#inspector");
      this.signature = "";
      this.city = null;
    }
    showCity(city) {
      this.city = city;
      this.signature = "";
    }
    render(layout, requests) {
      const selected = this.host.selected(),
        units = layout.units.filter((unit) => selected.has(unit.chat.id));
      const city =
        !units.length && this.city ? layout.cities.find((c) => c.id === this.city) : null;
      if (!city) this.city = null;
      const signature = JSON.stringify([
        units.map(({ chat }) => [
          chat.id,
          chat.title,
          chat.status,
          chat.activity,
          chat.problem,
          chat.lastTurn,
        ]),
        requests.filter((request) => selected.has(request.chatId)),
        city &&
          layout.units
            .filter((unit) => unit.city === city.id)
            .map(({ chat }) => [chat.id, chat.status]),
        window.zolt.granted,
        this.host.actions.busy,
        this.host.actions.saved.presets,
      ]);
      if (signature === this.signature) return;
      this.signature = signature;
      const keep = document.activeElement?.dataset?.keep,
        inside = this.container.contains(document.activeElement);
      this.container.replaceChildren();
      this.container.hidden = !units.length && !city;
      if (this.container.hidden) return;
      const close = el("button", { type: "button", class: "close", "aria-label": "Close" }, "✕");
      close.onclick = () => {
        this.city = null;
        this.host.clear();
      };
      if (units.length === 1) this.one(units[0].chat, requests, layout);
      else if (units.length) this.many(units.map((unit) => unit.chat));
      else this.town(city, layout);
      this.container.prepend(close);
      if (inside) {
        const target = keep ? this.container.querySelector(`[data-keep="${keep}"]`) : null;
        (target ?? this.container.querySelector("h2"))?.focus({ preventScroll: true });
      }
    }
    one(chat, requests, layout) {
      const unit = layout.units.find((u) => u.chat.id === chat.id),
        district = layout.districts.find((d) => d.id === unit?.district),
        city = layout.cities.find((c) => c.id === unit?.city);
      const { problem } = map.unitState(chat);
      this.container.className = "panel-card unit-card";
      this.container.style.setProperty("--agent", map.providerColor(chat));
      this.container.setAttribute("aria-label", chat.title);
      const head = el(
        "div",
        { class: "head" },
        el("h2", { tabindex: "-1" }, chat.title),
        el(
          "p",
          { class: "state" },
          map.stateIcon(chat),
          problem
            ? chat.problem
              ? "Has a problem"
              : "Last turn failed"
            : (chat.activity ?? map.statusLabels[chat.status]),
        ),
      );
      const meta = el(
        "p",
        { class: "meta" },
        el("span", {}, el("i", { class: "dot" }), chat.provider?.name ?? "Agent"),
        city ? el("span", {}, city.name) : null,
        district ? el("span", { class: "branch" }, district.name) : null,
        el("span", {}, map.statusLabels[chat.status]),
      );
      this.container.append(portrait(chat), head, meta);
      for (const request of requests.filter((r) => r.chatId === chat.id))
        this.container.append(this.host.actions.request(request, chat));
      const row = el("div", { class: "actions" });
      const open = el(
        "button",
        { type: "button", "aria-label": `Open chat: ${chat.title}` },
        "Open chat",
      );
      open.onclick = () => this.host.open(chat.id);
      row.append(open);
      this.container.append(row);
      if (chat.status !== "needs_you") {
        const orders = this.host.actions.orders([chat.id]);
        if (orders) this.container.append(orders);
      }
    }
    many(chats) {
      this.container.className = "panel-card group-card";
      this.container.setAttribute("aria-label", `${chats.length} chats selected`);
      const list = el("ul", { class: "picked" });
      for (const chat of chats) {
        const item = el(
          "button",
          { type: "button", "aria-label": `Show ${chat.title}` },
          map.stateIcon(chat),
          chat.title,
        );
        item.onclick = () => this.host.find(chat.id);
        list.append(el("li", {}, item));
      }
      this.container.append(el("h2", { tabindex: "-1" }, `${chats.length} chats selected`), list);
      const orders = this.host.actions.orders(chats.map((chat) => chat.id));
      if (orders) this.container.append(orders);
    }
    town(city, layout) {
      this.container.className = "panel-card city-card";
      this.container.style.setProperty("--city", map.cityColor(city));
      this.container.setAttribute("aria-label", city.name);
      const list = el("ul", { class: "picked" });
      for (const { chat } of layout.units.filter((unit) => unit.city === city.id)) {
        const district = layout.districts.find((d) => d.id === chat.worktree?.id);
        const item = el(
          "button",
          { type: "button", "aria-label": `Show ${chat.title}, ${map.stateWords(chat, [])}` },
          map.stateIcon(chat),
          el("span", { class: "title" }, chat.title),
          el("span", { class: "branch" }, district?.name ?? ""),
        );
        item.onclick = () => this.host.find(chat.id);
        list.append(el("li", {}, item));
      }
      this.container.append(el("h2", { tabindex: "-1" }, city.name), list);
    }
  };
})();
