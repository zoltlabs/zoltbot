// What a chat's data means on the map: its state, its label, how long it has waited, and the
// small icon that stands for each state in the list, the labels and the minimap.
(() => {
  window.CommandMap = window.CommandMap || {};
  const map = window.CommandMap;

  map.statusLabels = {
    needs_you: "Needs you",
    working: "Working",
    review: "Done",
    later: "Later",
    idle: "Idle",
    settled: "Settled",
  };
  // The map draws five states. "later" looks like idle; a failed turn or a session problem
  // adds a warning to whatever state the chat is in.
  map.unitState = (chat) => ({
    state: ["needs_you", "working", "review"].includes(chat.status) ? chat.status : "idle",
    problem: !!chat.problem || chat.lastTurn?.status === "failed",
  });
  // When the chat started waiting for its owner: its oldest request, or its last update.
  map.waitingSince = (chat, requests) => {
    const times = requests
      .filter((request) => request.chatId === chat.id)
      .map((request) => Date.parse(request.createdAt))
      .filter(Number.isFinite);
    return times.length ? Math.min(...times) : Date.parse(chat.updatedAt);
  };
  // "now", "4 min", "2 h" or "3 d", with a longer form for screen readers.
  map.waited = (since, now = Date.now()) => {
    const minutes = Math.floor((now - since) / 60000);
    if (!(minutes >= 1)) return { short: "now", long: "less than a minute" };
    if (minutes < 60)
      return { short: `${minutes} min`, long: `${minutes} minute${minutes === 1 ? "" : "s"}` };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { short: `${hours} h`, long: `${hours} hour${hours === 1 ? "" : "s"}` };
    const days = Math.floor(hours / 24);
    return { short: `${days} d`, long: `${days} day${days === 1 ? "" : "s"}` };
  };

  // 16 by 16 icons. State icons match the shape of the mark above the unit on the map.
  const icons = {
    needs_you: "M8 1.5 13 8l-5 6.5L3 8z",
    working: "M8 2l5.2 3v6L8 14l-5.2-3V5zM8 6a2 2 0 100 4 2 2 0 000-4z",
    review: "M4 14V2h1.5v1L13 6l-7.5 3v5z",
    idle: "M4 9.5h8V12H4z",
    problem: "M8 1.8 15 14H1zM7.3 6.2v4h1.4v-4zM7.3 11.2v1.4h1.4v-1.4z",
    spend:
      "M8 2a6 6 0 100 12A6 6 0 008 2zm-.6 2.6h1.2v.8c.9.2 1.5.8 1.6 1.7H9c-.1-.4-.4-.7-1-.7s-1 .3-1 .7c0 .5.4.6 1.2.8 1.2.3 2.1.7 2.1 1.9 0 .9-.7 1.6-1.7 1.8v.8H7.4v-.8c-1-.2-1.7-.9-1.8-1.9h1.3c.1.5.5.8 1.1.8s1.1-.3 1.1-.7c0-.5-.4-.6-1.3-.9-1.1-.3-2-.7-2-1.8 0-.9.7-1.5 1.6-1.7z",
    active: "M9 1 3.5 9H7l-1 6 5.5-8H8z",
    requests: "M8 1.5a4 4 0 00-4 4V9l-1.5 2.5h11L12 9V5.5a4 4 0 00-4-4zM6.5 13a1.5 1.5 0 003 0z",
    checks:
      "M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM5.6 4.6 8 7l2.4-2.4 1 1L9 8l2.4 2.4-1 1L8 9l-2.4 2.4-1-1L7 8 4.6 5.6z",
    arrow: "M8 1.5 14 9h-4v5.5H6V9H2z",
    soundOn: "M2 6h3l4-3.5v11L5 10H2zM11 5.2a4 4 0 010 5.6l.9.9a5.3 5.3 0 000-7.4z",
    soundOff:
      "M2 6h3l4-3.5v11L5 10H2zM10.6 6l1.2 1.2L13 6l.9.9-1.2 1.2 1.2 1.2-.9.9-1.2-1.2-1.2 1.2-.9-.9 1.2-1.2-1.2-1.2z",
    fit: "M2 2h4.5v1.5h-3v3H2zM9.5 2H14v4.5h-1.5v-3h-3zM2 9.5h1.5v3h3V14H2zM12.5 9.5H14V14H9.5v-1.5h3z",
    save: "M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z",
  };
  map.icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `icon icon-${name}`);
    path.setAttribute("d", icons[name]);
    path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
    return svg;
  };
  // The icon for a chat: its warning if it has one and is not waiting for the owner.
  map.stateIcon = (chat) => {
    const { state, problem } = map.unitState(chat);
    return map.icon(problem && state !== "needs_you" ? "problem" : state);
  };

  // Builds an element: el("button", { class: "chip", type: "button" }, "Text", child).
  map.el = (tag, attributes = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes))
      if (value === true) element.setAttribute(name, "");
      else if (value !== false && value !== undefined) element.setAttribute(name, value);
    element.append(...children.filter((child) => child !== undefined && child !== null));
    return element;
  };
})();
