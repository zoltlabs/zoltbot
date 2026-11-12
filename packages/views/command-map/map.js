// The controller: connects Zoltbot's data to the map, the list and the panels.
(() => {
  const map = window.CommandMap,
    $ = (selector) => document.querySelector(selector),
    topics = { chats: [], requests: [], workspaces: [], checks: [], usage: null };
  let scene,
    panel,
    hud,
    list,
    sound,
    paused = false,
    selected = new Set(),
    layout,
    drawn = "",
    known; // each chat's last state, to notice changes worth a sound

  const showError = (error) => {
    $("#error").textContent = error.message;
  };
  const open = (id) => window.zolt.app.open({ chatId: id }).catch(showError);
  function select(ids) {
    selected = new Set(ids);
    scene?.setSelection(ids);
    list?.render(layout?.units ?? []);
    hud?.renderGroups();
    panel?.render();
  }
  function find(id) {
    select([id]);
    scene?.focus(id);
  }
  function nextAlert() {
    const waiting = topics.chats
      .filter((chat) => chat.status === "needs_you")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!waiting.length) return;
    const index = waiting.findIndex((chat) => selected.has(chat.id));
    const chat = waiting[(index + 1) % waiting.length];
    find(chat.id);
    $("#live").textContent = `${chat.title} needs you`;
  }
  // Plays a sound when a chat starts waiting, finishes or fails. Silent on the first load.
  function listen() {
    const next = new Map(topics.chats.map((chat) => [chat.id, map.unitState(chat)]));
    if (known)
      for (const [id, now] of next) {
        const before = known.get(id);
        if (!before) continue;
        if (now.problem && !before.problem) sound.play("failed");
        else if (now.state === "needs_you" && before.state !== "needs_you") sound.play("needsYou");
        else if (now.state === "review" && before.state !== "review") sound.play("finished");
      }
    known = next;
  }
  function render() {
    layout = window.commandMapLayout(topics.chats, topics.workspaces, panel?.saved.regions);
    // Redraw the world only when something it shows has changed.
    const signature = JSON.stringify([
      layout.regions,
      layout.bases,
      layout.units.map(({ chat, x, z }) => [
        chat.id,
        chat.title,
        chat.status,
        chat.provider.id,
        map.unitState(chat).problem,
        x,
        z,
      ]),
      topics.requests.map((request) => [request.chatId, request.createdAt]),
    ]);
    if (signature !== drawn) {
      drawn = signature;
      scene?.setData(layout, topics.requests);
      scene?.setSelection([...selected]);
    }
    listen();
    list?.render(layout.units);
    panel?.render();
    hud?.renderStats(topics);
    hud?.renderGroups();
    const waiting = topics.chats.filter((chat) => chat.status === "needs_you").length;
    $("#alert").disabled = !waiting;
    $("#alert-count").hidden = !waiting;
    $("#alert-count").textContent = String(waiting);
  }

  $("#alert").onclick = nextAlert;
  $("#zoom-in").onclick = () => scene?.scale(1.25);
  $("#zoom-out").onclick = () => scene?.scale(0.8);
  $("#fit").onclick = () => scene?.fit();
  $("#fit").append(map.icon("fit"));
  for (const button of document.querySelectorAll("[data-pan]"))
    button.onclick = () => {
      const [across, down] = button.dataset.pan.split(",").map(Number);
      scene?.pan(across, down);
    };
  $("#pause").onclick = () => {
    paused = !paused;
    $("#pause").textContent = paused ? "Resume updates" : "Pause updates";
    $("#pause").setAttribute("aria-pressed", String(paused));
    if (!paused) render();
  };
  function showSound(enabled) {
    $("#sound").setAttribute("aria-pressed", String(enabled));
    $("#sound").replaceChildren(map.icon(enabled ? "soundOn" : "soundOff"));
  }
  $("#sound").onclick = () => {
    const enabled = !sound.enabled;
    sound.setEnabled(enabled);
    showSound(enabled);
    if (enabled) sound.play("finished"); // so the owner hears that it works
    panel.saved.sound = enabled || undefined;
    panel.save();
  };
  $("#quality").onchange = () => {
    const choice = $("#quality").value;
    scene?.setQuality(choice);
    panel.saved.quality = choice === "auto" ? undefined : choice;
    panel.save();
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
      let saved;
      try {
        saved = await window.zolt.storage.get();
      } catch (error) {
        showError(error);
      }
      sound = new map.Sound(map.skin);
      list = new map.ChatList({ selected: () => selected, select, find, open });
      panel = new window.CommandMapPanel(
        {
          topics,
          selected: () => selected,
          select,
          error: showError,
          layout: () => {
            render();
          },
          regions: () => layout?.regions ?? [],
          groups: () => hud.renderGroups(),
        },
        saved,
      );
      hud = new map.Hud({
        selected: () => selected,
        groups: () => panel.saved.groups,
        recallGroup: (id) => panel.recallGroup(id),
        saveGroup: (id) => panel.saveGroup(id),
      });
      try {
        scene = new map.Scene({
          open,
          select,
          moveRegion: (id, x, z) => panel.move(id, x, z),
          reducedMotion: facts.reducedMotion,
          // Shows which level "Auto" picked.
          onLevel: (level) => {
            $("#quality").options[0].textContent = `Auto (${level})`;
          },
        });
        $("#quality").options[0].textContent = `Auto (${scene.quality.level})`;
        if (panel.saved.quality) {
          $("#quality").value = panel.saved.quality;
          scene.setQuality(panel.saved.quality);
        }
        map.scene = scene;
      } catch {
        $("#error").textContent = "The map could not use WebGL. Your chats are listed below.";
        $("#quality").disabled = true;
      }
      // Audio can only start after a click or key press, so a saved "on" waits for one.
      showSound(!!panel.saved.sound);
      if (panel.saved.sound) {
        const start = () => {
          if ($("#sound").getAttribute("aria-pressed") === "true") sound.setEnabled(true);
          window.removeEventListener("pointerdown", start);
          window.removeEventListener("keydown", start);
        };
        window.addEventListener("pointerdown", start);
        window.addEventListener("keydown", start);
      }
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
      // Waiting times on alerts advance even when no data arrives.
      setInterval(() => {
        scene?.overlay.tick();
      }, 30000);
    })
    .catch(showError);
  window.addEventListener("pagehide", () => {
    scene?.dispose();
    panel?.dispose();
    sound?.dispose();
  });
})();
