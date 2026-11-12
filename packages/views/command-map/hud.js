// The heads-up display over the map: today's numbers along the top and the control group
// chips along the bottom. (The minimap, alerts and name tags have their own files.)
(() => {
  const map = window.CommandMap,
    { el } = map;
  const money = (value) => `$${value.toFixed(2)}`,
    plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  map.Hud = class {
    // host: { selected(): Set, groups(): saved groups, recallGroup(id), saveGroup(id) }
    constructor(host) {
      this.host = host;
      this.stats = document.querySelector("#resources");
      this.groups = document.querySelector("#groups");
    }
    // Spend against the budget, active chats, pending requests, failing required checks.
    renderStats({ usage, requests, checks }) {
      const stat = (icon, text, tone) =>
        el("li", { class: `stat ${tone ?? ""}` }, map.icon(icon), text);
      if (!usage) {
        this.stats.replaceChildren(el("li", { class: "stat" }, "Loading…"));
        return;
      }
      const spent = usage.today.costUsd,
        limit = usage.budget?.limitUsd;
      const spend = stat(
        "spend",
        `${usage.today.costKnown ? "" : "About "}${money(spent)}${limit ? ` of ${money(limit)}` : ""} today`,
        limit && spent >= limit ? "over" : "",
      );
      if (limit) {
        const meter = el("span", { class: "meter", "aria-hidden": "true" }, el("span"));
        meter.firstChild.style.width = `${Math.min(100, (spent / limit) * 100)}%`;
        spend.append(meter);
      }
      const failing = checks.filter((check) => check.required && check.state === "failing").length;
      this.stats.replaceChildren(
        spend,
        stat("active", plural(usage.activeChats, "active chat")),
        stat("requests", plural(requests.length, "request"), requests.length ? "waiting" : ""),
        ...(failing ? [stat("checks", plural(failing, "failing check"), "failing")] : []),
      );
    }
    // One chip per control group: select it, or save the current selection into it.
    renderGroups() {
      const focused = document.activeElement?.dataset?.group,
        selected = this.host.selected(),
        groups = this.host.groups();
      this.groups.replaceChildren(
        ...["1", "2", "3"].map((id) => {
          const size = groups[id]?.length ?? 0;
          const select = el(
            "button",
            {
              type: "button",
              "aria-label": `Select group ${id}`,
              title: `Press ${id}`,
              "data-group": `select-${id}`,
            },
            el("kbd", {}, id),
            size ? el("span", { class: "size" }, plural(size, "chat")) : undefined,
          );
          select.disabled = !size;
          select.onclick = () => this.host.recallGroup(id);
          const save = el(
            "button",
            {
              type: "button",
              "aria-label": `Save group ${id}`,
              title: `Save the selection as group ${id} (Shift+${id})`,
              "data-group": `save-${id}`,
            },
            map.icon("save"),
          );
          save.disabled = !selected.size;
          save.onclick = () => this.host.saveGroup(id);
          return el("div", { class: "group" }, select, save);
        }),
      );
      if (focused)
        this.groups
          .querySelector(`[data-group="${focused}"]:not(:disabled)`)
          ?.focus({ preventScroll: true });
    }
  };
})();
