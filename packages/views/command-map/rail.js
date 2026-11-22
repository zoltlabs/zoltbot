// The list on the left: requests you can answer in place, then Done, Working and Idle chats.
// It is the keyboard and screen-reader path to everything the map shows.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const SECTIONS = [
    ["review", "Done"],
    ["working", "Working"],
    ["idle", "Idle"],
  ];
  map.Rail = class {
    // host: { actions, selected(): Set, select(id, add), find(id) }
    constructor(host) {
      this.host = host;
      this.asks = document.querySelector("#asks");
      this.lists = document.querySelector("#lists");
      this.empty = document.querySelector("#empty");
      this.signatures = {};
      this.idleOpen = false;
    }
    render(units, requests, chats) {
      const selected = this.host.selected();
      // Requests: rebuilt only when they change, so a half-typed answer survives updates.
      const askSignature = JSON.stringify([requests, window.zolt.granted, this.host.actions.busy]);
      if (askSignature !== this.signatures.asks) {
        this.signatures.asks = askSignature;
        const byId = new Map(chats.map((chat) => [chat.id, chat]));
        const sorted = requests.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
        const heading = el("h2", {}, "Needs you");
        if (sorted.length) heading.append(el("span", { class: "count" }, String(sorted.length)));
        this.asks.replaceChildren(
          heading,
          ...(sorted.length
            ? sorted.map((request) =>
                this.host.actions.request(request, byId.get(request.chatId), {
                  who: (id) => this.host.find(id),
                }),
              )
            : [el("p", { class: "hint" }, "Nothing needs you.")]),
        );
      }
      // Chats by state. Chats that need you are already above, as requests.
      const rows = units
        .map(({ chat }) => ({ chat, ...map.unitState(chat) }))
        .filter(({ state }) => state !== "needs_you");
      const signature = JSON.stringify([
        rows.map(({ chat, problem }) => [
          chat.id,
          chat.title,
          chat.status,
          problem,
          chat.activity,
          chat.updatedAt,
        ]),
        [...selected],
      ]);
      this.empty.hidden = units.length > 0 || requests.length > 0;
      if (signature === this.signatures.lists) return;
      this.signatures.lists = signature;
      const focused = document.activeElement?.dataset?.row;
      const open = this.lists.querySelector("details")?.open;
      if (open !== undefined) this.idleOpen = open;
      const sections = SECTIONS.map(([state, title]) => {
        const list = rows
          .filter((row) => row.state === state)
          .sort(
            (a, b) =>
              Number(b.problem) - Number(a.problem) ||
              b.chat.updatedAt.localeCompare(a.chat.updatedAt),
          );
        if (!list.length) return null;
        const items = el("ul", { class: "rows" }, ...list.map((row) => this.row(row, selected)));
        if (state === "idle") {
          const details = el(
            "details",
            {},
            el("summary", {}, title, el("span", { class: "count quiet" }, String(list.length))),
            items,
          );
          details.open = this.idleOpen || list.some(({ chat }) => selected.has(chat.id));
          return el("section", {}, details);
        }
        return el(
          "section",
          {},
          el("h2", {}, title, el("span", { class: "count" }, String(list.length))),
          items,
        );
      });
      this.lists.replaceChildren(...sections.filter(Boolean));
      if (focused)
        this.lists
          .querySelector(`[data-row="${CSS.escape(focused)}"]`)
          ?.focus({ preventScroll: true });
    }
    row({ chat, problem }, selected) {
      const when =
        chat.status === "working" || chat.status === "review"
          ? map.waited(Date.parse(chat.updatedAt)).short
          : "";
      const detail = problem
        ? chat.problem
          ? "Has a problem"
          : "Last turn failed"
        : (chat.activity ?? `${chat.provider?.name ?? ""}`);
      const item = el(
        "button",
        {
          type: "button",
          class: problem ? "problem" : "",
          "data-row": chat.id,
          "aria-pressed": String(selected.has(chat.id)),
          "aria-label": `${chat.title}, ${map.stateWords(chat, [])}`,
        },
        map.stateIcon(chat),
        el("span", { class: "title" }, chat.title),
        el("span", { class: "when" }, when),
        el("span", { class: "detail" }, detail),
      );
      item.onclick = (event) => this.host.select(chat.id, event.shiftKey || event.metaKey);
      return el("li", { class: selected.has(chat.id) ? "selected" : "" }, item);
    }
  };
})();
