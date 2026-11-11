(() => {
  const $ = (selector) => document.querySelector(selector),
    topics = { chats: [], requests: [], workspaces: [], checks: [], usage: null };
  let scene,
    panel,
    paused = false,
    selected = new Set(),
    layout;
  const status = {
    needs_you: "Needs you",
    working: "Working",
    review: "Done",
    later: "Later",
    idle: "Idle",
    settled: "Settled",
  };
  const showError = (error) => {
    $("#error").textContent = error.message;
  };
  const open = (id) => window.zolt.app.open({ chatId: id }).catch(showError);
  function select(ids) {
    selected = new Set(ids);
    scene?.setSelection(ids);
    renderList();
    panel?.render();
  }
  function nextAlert() {
    const list = topics.chats
      .filter((chat) => chat.status === "needs_you")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!list.length) return;
    const index = list.findIndex((chat) => selected.has(chat.id));
    const chat = list[(index + 1) % list.length];
    select([chat.id]);
    scene?.focus(chat.id);
    $("#live").textContent = `${chat.title} needs you`;
  }
  function renderList() {
    const container = $("#chats");
    const focusId = document.activeElement?.dataset?.focusId;
    container.replaceChildren();
    $("#empty").hidden = !!layout?.units.length;
    for (const { chat } of layout?.units ?? []) {
      const item = document.createElement("li"),
        label = document.createElement("label"),
        checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(chat.id);
      checkbox.dataset.focusId = `select-${chat.id}`;
      checkbox.onchange = () => {
        const next = new Set(selected);
        if (checkbox.checked) next.add(chat.id);
        else next.delete(chat.id);
        select([...next]);
      };
      label.append(
        checkbox,
        document.createTextNode(
          `${chat.title} — ${status[chat.status]}${chat.problem || chat.lastTurn?.status === "failed" ? " ⚠ Warning" : ""}`,
        ),
      );
      item.append(label);
      const detail = document.createElement("p");
      detail.textContent = `${chat.profile.name} · ${chat.provider.name}${chat.activity ? ` · ${chat.activity}` : ""}`;
      item.append(detail);
      for (const [name, action] of [
        [
          "Find on map",
          () => {
            select([chat.id]);
            scene?.focus(chat.id);
          },
        ],
        ["Open chat", () => open(chat.id)],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.setAttribute("aria-label", `${name}: ${chat.title}`);
        button.dataset.focusId = `${name}-${chat.id}`;
        button.onclick = action;
        item.append(button);
      }
      container.append(item);
    }
    if (focusId)
      for (const element of container.querySelectorAll("[data-focus-id]"))
        if (element.dataset.focusId === focusId) element.focus({ preventScroll: true });
  }
  function render() {
    layout = window.commandMapLayout(topics.chats, topics.workspaces, panel?.saved.regions);
    scene?.setData(layout);
    scene?.setSelection([...selected]);
    renderList();
    panel?.render();
    const usage = topics.usage,
      failures = topics.checks.filter(
        (check) => check.required && check.state === "failing",
      ).length;
    $("#resources").textContent = usage
      ? `${usage.today.costKnown ? "Spending" : "Estimated spending"}: $${usage.today.costUsd.toFixed(2)}${usage.budget ? ` of $${usage.budget.limitUsd.toFixed(2)} per day` : ""} · ${usage.activeChats} active chat${usage.activeChats === 1 ? "" : "s"} · ${topics.requests.length} request${topics.requests.length === 1 ? "" : "s"} · ${failures} failing required check${failures === 1 ? "" : "s"}`
      : "Loading usage…";
    $("#alert").disabled = !topics.chats.some((chat) => chat.status === "needs_you");
  }
  $("#alert").onclick = nextAlert;
  $("#zoom-in").onclick = () => scene?.scale(1.25);
  $("#zoom-out").onclick = () => scene?.scale(0.8);
  for (const button of document.querySelectorAll("[data-pan]"))
    button.onclick = () => {
      const [x, z] = button.dataset.pan.split(",").map(Number);
      scene?.center(scene.cx + x, scene.cz + z);
    };
  $("#pause").onclick = () => {
    paused = !paused;
    $("#pause").textContent = paused ? "Resume updates" : "Pause updates";
    $("#pause").setAttribute("aria-pressed", String(paused));
    if (!paused) render();
  };
  window.addEventListener("keydown", (event) => {
    if (
      event.target.matches("input,textarea,button,select") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      nextAlert();
    }
  });
  window.zolt.ready
    .then(async (facts) => {
      $("#sample").hidden = !facts.mock;
      try {
        scene = new window.CommandMapScene(open, select, (id, x, z) => panel?.move(id, x, z));
      } catch {
        $("#error").textContent = "The map could not use WebGL. Your chats are listed below.";
      }
      let saved;
      try {
        saved = await window.zolt.storage.get();
      } catch (error) {
        showError(error);
      }
      panel = new window.CommandMapPanel(
        {
          topics,
          selected: () => selected,
          select,
          error: showError,
          layout: render,
          regions: () => layout?.regions ?? [],
        },
        saved,
      );
      window.zolt.on("grants", () => {
        panel.signature = "";
        panel.render();
      });
      window.zolt.subscribe(
        ["chats", "requests", "workspaces", "usage", "checks"],
        (topic, value) => {
          topics[topic] = value;
          if (!paused) render();
        },
      );
      window.zolt.on("theme", () => scene?.theme());
      window.zolt.on("visibility", (visible) => scene?.visibility(visible));
      window.zolt.on("shortcut", (id) => {
        if (id === "next-alert") nextAlert();
      });
    })
    .catch(showError);
  window.addEventListener("pagehide", () => {
    scene?.dispose();
    panel?.dispose();
  });
})();
