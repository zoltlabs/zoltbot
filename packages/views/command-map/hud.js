// The top bar (today's spend, working and done chats, failing checks) and, at the bottom right
// of the map, the stack of notifications and the round button that jumps to the next request.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const money = (value) => `$${value.toFixed(2)}`,
    plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  map.Hud = class {
    // host: { next(), find(id) }
    constructor(host) {
      this.host = host;
      this.stats = document.querySelector("#stats");
      this.notes = document.querySelector("#notes");
      this.next = document.querySelector("#next");
      this.next.onclick = () => this.host.next();
    }
    renderStats({ usage, checks, chats }) {
      const stat = (icon, strong, text, tone = "") =>
        el(
          "li",
          { class: `stat ${tone}` },
          el("span", { class: `gem ${icon}` }, map.icon(icon)),
          el("strong", {}, strong),
          text,
        );
      if (!usage) {
        this.stats.replaceChildren(el("li", { class: "stat" }, "Loading…"));
        return;
      }
      const spent = usage.today.costUsd,
        limit = usage.budget?.limitUsd;
      const working = chats.filter((chat) => chat.status === "working").length,
        done = chats.filter((chat) => chat.status === "review").length,
        failing = checks.filter((check) => check.required && check.state === "failing");
      const items = [
        stat(
          "spend",
          `${usage.today.costKnown ? "" : "About "}${money(spent)}`,
          limit ? ` of ${money(limit)} today` : " today",
          limit && spent >= limit ? "over" : "",
        ),
        stat("working", String(working), " working"),
        stat("review", String(done), " done"),
      ];
      if (failing.length) {
        const names = [...new Set(failing.map((check) => check.name))];
        items.push(
          stat(
            "problem",
            failing.length === 1 ? `${names[0]} failing` : plural(failing.length, "failing check"),
            "",
            "failing",
          ),
        );
      }
      this.stats.replaceChildren(...items);
    }
    // One disc per thing to look at: problems, finished chats, and requests (newest on top).
    renderNotes(units, requests) {
      const chats = units.map((unit) => unit.chat);
      const notes = [
        ...chats
          .filter((chat) => map.unitState(chat).problem && chat.status !== "needs_you")
          .map((chat) => ({
            id: chat.id,
            icon: "problem",
            text: `${chat.problem ? "Problem" : "Failed"}: ${chat.title}`,
          })),
        ...chats
          .filter((chat) => chat.status === "review")
          .map((chat) => ({ id: chat.id, icon: "review", text: `Done: ${chat.title}` })),
        ...requests
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((request) => {
            const chat = chats.find((c) => c.id === request.chatId);
            return {
              id: request.chatId,
              icon: "needs_you",
              text: `${request.title} ${chat ? `(${chat.title})` : ""}`.trim(),
              loud: true,
            };
          }),
      ].slice(-7);
      this.notes.replaceChildren(
        ...notes.map((note) => {
          const button = el(
            "button",
            { type: "button", class: `note ${note.loud ? "loud" : ""}`, "aria-label": note.text },
            el("span", { class: "text", "aria-hidden": "true" }, note.text),
            el("span", { class: `disc ${note.icon}` }, map.icon(note.icon)),
          );
          button.onclick = () => this.host.find(note.id);
          return el("li", {}, button);
        }),
      );
      const count = requests.length;
      this.next.classList.toggle("calm", !count);
      this.next.disabled = !count;
      this.next.setAttribute(
        "aria-label",
        count ? `Next request, ${count} waiting` : "Nothing needs you",
      );
      this.next.replaceChildren(
        ...(count
          ? [
              el("strong", {}, String(count)),
              el("span", {}, count === 1 ? "request" : "requests"),
              el("kbd", {}, "Space"),
            ]
          : [el("span", {}, "All clear")]),
      );
    }
  };
})();
