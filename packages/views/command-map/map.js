// The controller: connects Zoltbot's data to the map, the list on the left and the panels.
(() => {
  const map = window.CommandMap,
    $ = (selector) => document.querySelector(selector),
    topics = { chats: [], requests: [], workspaces: [], checks: [], usage: null };
  let world,
    camera,
    labels,
    rail,
    inspector,
    hud,
    actions,
    sound,
    layout = { cities: [], districts: [], units: [], land: [] },
    selected = new Set(),
    drawn = "",
    fitted = false,
    known; // each chat's last state, to notice changes worth a sound

  const showError = (error) => {
    $("#error").textContent = error?.message ?? "";
  };
  const say = (text) => {
    $("#live").textContent = text;
  };
  const open = (id) => window.zolt.app.open({ chatId: id }).catch(showError);
  const unitOf = (id) => layout.units.find((unit) => unit.chat.id === id);

  function refresh() {
    world?.setMarks(selected);
    labels?.render();
    rail?.render(layout.units, topics.requests, topics.chats);
    inspector?.render(layout, topics.requests);
  }
  function select(id, add = false) {
    if (add) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      selected = new Set(selected);
    } else selected = new Set([id]);
    refresh();
    if (!add) center(id);
  }
  function clear() {
    selected = new Set();
    inspector?.showCity(null);
    refresh();
  }
  function center(id) {
    const unit = unitOf(id);
    if (!unit || !camera) return;
    camera.goTo(world.at(unit.q, unit.r), Math.max(camera.zoom, 1.1), 0.58, 0.36);
  }
  function find(id) {
    selected = new Set([id]);
    refresh();
    center(id);
  }
  function showCity(id) {
    const city = layout.cities.find((c) => c.id === id);
    if (!city) return;
    selected = new Set();
    inspector.showCity(id);
    refresh();
    camera.goTo(world.at(city.q, city.r), Math.max(camera.zoom, 0.9), 0.58, 0.36);
  }
  // Goes to the chat that has waited longest; pressing again goes to the next one.
  function next() {
    const waiting = topics.chats
      .filter((chat) => chat.status === "needs_you" && unitOf(chat.id))
      .toSorted(
        (a, b) =>
          map.waitingSince(a, topics.requests) - map.waitingSince(b, topics.requests) ||
          a.id.localeCompare(b.id),
      );
    if (!waiting.length) return;
    const index = waiting.findIndex((chat) => selected.has(chat.id));
    const chat = waiting[(index + 1) % waiting.length];
    find(chat.id);
    say(`${chat.title} needs you`);
  }
  // Plays a sound when a chat starts waiting, finishes or fails. Silent on the first load.
  function listen() {
    const now = new Map(topics.chats.map((chat) => [chat.id, map.unitState(chat)]));
    if (known)
      for (const [id, state] of now) {
        const before = known.get(id);
        if (!before) continue;
        if (state.problem && !before.problem) sound.play("failed");
        else if (state.state === "needs_you" && before.state !== "needs_you") sound.play("needsYou");
        else if (state.state === "review" && before.state !== "review") sound.play("finished");
      }
    known = now;
  }
  function render() {
    layout = window.commandMapLayout(topics.chats, topics.workspaces);
    const ids = new Set(layout.units.map((unit) => unit.chat.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    // Redraw the world only when something it shows has changed.
    const signature = JSON.stringify([
      layout.cities,
      layout.districts,
      layout.units.map(({ chat, q, r }) => [chat.id, chat.status, chat.provider?.id, map.unitState(chat).problem, q, r]),
    ]);
    if (signature !== drawn) {
      drawn = signature;
      world.setData(layout);
    }
    listen();
    refresh();
    hud.renderStats(topics);
    hud.renderNotes(layout.units, topics.requests);
    if (!fitted && layout.land.length) {
      fitted = true;
      camera.fit();
    }
  }

  $("#zoom-in").onclick = () => camera?.scale(1.25);
  $("#zoom-out").onclick = () => camera?.scale(0.8);
  $("#fit").onclick = () => camera?.fit();
  $("#fit").append(map.icon("fit"));
  function showSound(enabled) {
    $("#sound").setAttribute("aria-pressed", String(enabled));
    $("#sound").replaceChildren(map.icon(enabled ? "soundOn" : "soundOff"));
  }
  $("#sound").onclick = () => {
    const enabled = !sound.enabled;
    sound.setEnabled(enabled);
    showSound(enabled);
    if (enabled) sound.play("finished"); // so the owner hears that it works
    actions.saved.sound = enabled || undefined;
    actions.save();
  };
  window.addEventListener("keydown", (event) => {
    if (event.target.matches("input,textarea,select") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === "Space" && !event.target.matches("button,summary,a")) {
      event.preventDefault();
      next();
    }
    if (event.key === "Escape") clear();
  });

  window.zolt.ready
    .then(async (facts) => {
      $("#sample").hidden = !facts.mock;
      document.documentElement.classList.toggle("still", !!facts.reducedMotion);
      let saved;
      try {
        saved = await window.zolt.storage.get();
      } catch (error) {
        showError(error);
      }
      sound = new map.Sound(map.skin);
      actions = new map.Actions({ error: showError, say, open, changed: refresh }, saved);
      world = new map.World($("#world"));
      const stage = $("#stage");
      camera = new map.Camera({
        stage,
        world,
        reducedMotion: !!facts.reducedMotion,
        onMove: () => labels?.place(),
        // Shift+drag: select every unit whose flag is inside the box.
        onBox: (rect) => {
          const box = stage.getBoundingClientRect();
          const picked = layout.units.filter(({ q, r }) => {
            const spot = camera.screen(world.at(q, r)),
              x = spot.x + box.left,
              y = spot.y + box.top - 20;
            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
          });
          selected = new Set(picked.map((unit) => unit.chat.id));
          refresh();
        },
      });
      const host = {
        world,
        camera,
        actions,
        selected: () => selected,
        requests: () => topics.requests,
        select,
        clear,
        find,
        open,
        city: showCity,
      };
      labels = new map.Labels(host);
      rail = new map.Rail(host);
      inspector = new map.Inspector(host);
      hud = new map.Hud({ next, find });
      map.debug = { camera, world, selected: () => selected, layout: () => layout };
      $("#world").addEventListener("click", (event) => {
        const unit = event.target.closest("[data-chat]");
        if (unit) select(unit.dataset.chat, event.shiftKey || event.metaKey);
        else if (!event.shiftKey) clear();
      });
      new ResizeObserver(() => labels.place()).observe(stage);
      showSound(!!actions.saved.sound);
      // Audio can only start after a click or key press, so a saved "on" waits for one.
      if (actions.saved.sound) {
        const start = () => {
          if ($("#sound").getAttribute("aria-pressed") === "true") sound.setEnabled(true);
          window.removeEventListener("pointerdown", start);
          window.removeEventListener("keydown", start);
        };
        window.addEventListener("pointerdown", start);
        window.addEventListener("keydown", start);
      }
      window.zolt.on("grants", () => {
        rail.signatures = {};
        inspector.signature = "";
        refresh();
      });
      window.zolt.subscribe(["chats", "requests", "workspaces", "usage", "checks"], (topic, value) => {
        topics[topic] = value;
        render();
      });
      window.zolt.on("visibility", (visible) => document.documentElement.classList.toggle("paused", !visible));
      window.zolt.on("shortcut", (id) => {
        if (id === "next-alert") next();
      });
      // Waiting times advance even when no data arrives.
      setInterval(() => {
        labels.tick();
        for (const card of document.querySelectorAll("[data-since] .wait"))
          card.textContent = map.waited(Date.parse(card.closest("[data-since]").dataset.since)).short;
      }, 30000);
    })
    .catch(showError);
  window.addEventListener("pagehide", () => sound?.dispose());
})();
