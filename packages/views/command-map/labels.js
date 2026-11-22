// Labels drawn over the map in HTML so they stay sharp and readable at every zoom: city
// banners, branch names on districts, and a flag over each unit. Flags and banners are buttons,
// so the map can be used with the keyboard and a screen reader.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const stateWords = (chat, requests) => {
    const { state, problem } = map.unitState(chat),
      words = [map.statusLabels[chat.status] ?? map.statusLabels[state]];
    if (state === "needs_you")
      words.push(`waiting ${map.waited(map.waitingSince(chat, requests)).long}`);
    if (problem) words.push(chat.problem ? "has a problem" : "last turn failed");
    return words.join(", ").toLowerCase();
  };
  map.stateWords = stateWords;

  map.Labels = class {
    // host: { world, camera, selected(): Set, requests(): [], select(id, add), city(id) }
    constructor(host) {
      this.host = host;
      this.container = document.querySelector("#labels");
      this.items = [];
    }
    render() {
      const { world } = this.host,
        selected = this.host.selected(),
        requests = this.host.requests(),
        focused = document.activeElement?.dataset?.label;
      const items = [];
      for (const city of world.layout.cities) {
        const chats = world.layout.units.filter((unit) => unit.city === city.id).map((u) => u.chat);
        const count = (state) => chats.filter((chat) => map.unitState(chat).state === state).length;
        const chips = ["needs_you", "working", "review"]
          .filter((state) => count(state))
          .map((state) =>
            el(
              "span",
              { class: `chip ${state}`, title: map.statusLabels[state] },
              map.icon(state),
              String(count(state)),
            ),
          );
        const summary = ["needs_you", "working", "review"]
          .filter((state) => count(state))
          .map((state) => `${count(state)} ${map.statusLabels[state].toLowerCase()}`)
          .join(", ");
        const banner = el(
          "button",
          {
            type: "button",
            class: "banner",
            "data-label": `city-${city.id}`,
            "aria-label": `${city.name}: ${chats.length} chat${chats.length === 1 ? "" : "s"}${summary ? `, ${summary}` : ""}`,
          },
          el("span", { class: "count" }, String(chats.length)),
          el("span", { class: "name" }, el("span", {}, city.name), ...chips),
        );
        banner.style.setProperty("--city", map.cityColor(city));
        banner.onclick = () => this.host.city(city.id);
        const top = world.at(city.q, city.r);
        items.push({
          element: banner,
          point: { x: top.x, y: top.y - 64 },
          anchor: "translate(-50%, -100%)",
        });
      }
      for (const district of world.layout.districts) {
        const point = world.at(district.q, district.r);
        items.push({
          element: el("span", { class: "district", title: district.name }, district.name),
          point: { x: point.x, y: point.y + 14 },
          district: true,
          anchor: "translate(-50%, 0)",
        });
      }
      const loud = world.layout.units.filter(({ chat }) => {
        const { state, problem } = map.unitState(chat);
        return state === "review" || (problem && state !== "needs_you");
      });
      const quiet = loud.length > 12;
      for (const unit of world.layout.units) {
        const { chat } = unit,
          { state, problem } = map.unitState(chat),
          shown =
            state === "needs_you" ||
            selected.has(chat.id) ||
            (!quiet && (state === "review" || problem));
        const ribbon = el(
          "span",
          { class: "ribbon" },
          el("span", { class: "unit-name" }, chat.title),
        );
        if (state === "needs_you")
          ribbon.append(
            el("span", { class: "wait" }, map.waited(map.waitingSince(chat, requests)).short),
          );
        const flag = el(
          "button",
          {
            type: "button",
            class: `flag unit ${state}${problem ? " problem" : ""}${shown ? " shown" : ""}${selected.has(chat.id) ? " selected" : ""}`,
            "data-chat": chat.id,
            "data-label": `chat-${chat.id}`,
            "aria-pressed": String(selected.has(chat.id)),
            "aria-label": `${chat.title}, ${stateWords(chat, requests)}`,
          },
          el("span", { class: "shield" }, map.stateIcon(chat)),
          ribbon,
        );
        flag.style.setProperty("--agent", map.providerColor(chat));
        flag.onclick = (event) => this.host.select(chat.id, event.shiftKey || event.metaKey);
        const top = world.at(unit.q, unit.r);
        items.push({
          element: flag,
          point: { x: top.x + 4, y: top.y - 22 },
          anchor: "translate(-13px, -100%)",
        });
      }
      this.items = items;
      this.container.replaceChildren(...items.map((item) => item.element));
      this.place();
      if (focused)
        this.container
          .querySelector(`[data-label="${CSS.escape(focused)}"]`)
          ?.focus({ preventScroll: true });
    }
    // Moves every label to its spot for the current camera. Called on every camera change.
    place() {
      const { camera } = this.host,
        width = camera.stage.clientWidth,
        height = camera.stage.clientHeight,
        tiny = camera.zoom < 0.55;
      for (const item of this.items) {
        const { x, y } = camera.screen(item.point);
        const off = x < -240 || y < -80 || x > width + 240 || y > height + 120;
        item.element.hidden = off || (item.district && tiny);
        if (!item.element.hidden)
          item.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ${item.anchor}`;
      }
    }
    // Waiting times advance even when no data arrives.
    tick() {
      const requests = this.host.requests();
      for (const unit of this.host.world.layout.units) {
        if (unit.chat.status !== "needs_you") continue;
        const flag = this.container.querySelector(`.flag[data-chat="${CSS.escape(unit.chat.id)}"]`);
        if (!flag) continue;
        flag.querySelector(".wait").textContent = map.waited(
          map.waitingSince(unit.chat, requests),
        ).short;
        flag.setAttribute("aria-label", `${unit.chat.title}, ${stateWords(unit.chat, requests)}`);
      }
    }
  };
})();
