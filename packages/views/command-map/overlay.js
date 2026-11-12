// Text drawn over the map: a nameplate on each island, a name tag on units, and alerts at the
// edge of the screen that point at chats waiting for the owner off screen.
(() => {
  const map = window.CommandMap,
    { el } = map;
  const MAX_ALERTS = 6;

  map.Overlay = class {
    // host: { camera, skin, open(id), select(ids), focus(id), center(x, z), moveRegion(id, x, z) }
    constructor(host) {
      this.host = host;
      this.regions = document.querySelector("#regions");
      this.labels = document.querySelector("#units");
      this.alerts = document.querySelector("#alerts");
      this.units = [];
      this.plates = [];
      this.selected = new Set();
      this.requests = [];
    }
    setData(layout, requests) {
      this.requests = requests;
      this.regions.replaceChildren();
      this.labels.replaceChildren();
      this.alerts.replaceChildren();
      this.plates = layout.regions.map((region) => ({ region, plate: this.plate(region) }));
      this.units = layout.units.map((unit) => {
        const { chat } = unit,
          { state, problem } = map.unitState(chat);
        const label = el(
          "button",
          {
            type: "button",
            class: "unit",
            "data-chat": chat.id,
            "data-state": state,
            hidden: true,
          },
          map.stateIcon(chat),
          el("span", { class: "unit-name" }, chat.title),
        );
        label.onclick = () => this.host.open(chat.id);
        this.labels.append(label);
        const entry = { ...unit, state, problem, label, sx: 0, sy: 0, onScreen: false };
        if (state === "needs_you") {
          entry.since = map.waitingSince(chat, requests);
          entry.time = el("span", { class: "wait" });
          label.append(entry.time);
          entry.arrow = map.icon("arrow");
          entry.alertTime = el("span", { class: "wait" });
          entry.alert = el(
            "button",
            { type: "button", class: "edge-alert", hidden: true },
            entry.arrow,
            el("span", { class: "unit-name" }, chat.title),
            entry.alertTime,
          );
          entry.alert.onclick = () => {
            this.host.focus(chat.id);
            this.host.select([chat.id]);
          };
          this.alerts.append(entry.alert);
        }
        return entry;
      });
      this.tick();
    }
    // An island's nameplate. Click to center on the island; drag to move the island.
    plate(region) {
      const plate = el(
        "button",
        { type: "button", class: "region", title: "Drag to move" },
        region.name,
      );
      let start,
        moved = false;
      plate.onpointerdown = (event) => {
        if (event.button !== 0) return;
        plate.setPointerCapture(event.pointerId);
        start = { point: this.ground(event), x: event.clientX, y: event.clientY };
        moved = false;
      };
      plate.onpointermove = (event) => {
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) moved = true;
      };
      plate.onpointerup = (event) => {
        const end = this.ground(event);
        if (moved && start?.point && end)
          this.host.moveRegion(
            region.id,
            region.x + end.x - start.point.x,
            region.z + end.z - start.point.z,
          );
        start = undefined;
      };
      plate.onpointercancel = () => {
        start = undefined;
        moved = false;
      };
      plate.onclick = () => {
        if (!moved) this.host.center(region.x + region.w / 2, region.z + region.d / 2);
      };
      this.regions.append(plate);
      return plate;
    }
    ground(event) {
      const rect = this.regions.getBoundingClientRect();
      return this.host.camera.ground(event.clientX - rect.left, event.clientY - rect.top);
    }
    setSelection(ids) {
      this.selected = new Set(ids);
    }
    setHover(unit) {
      this.hovered = unit?.chat.id;
    }
    // Refreshes waiting times. Called on new data and once a minute.
    tick() {
      for (const unit of this.units) {
        if (!unit.alert) continue;
        const waited = map.waited(unit.since);
        unit.time.textContent = waited.short;
        unit.alertTime.textContent = waited.short;
        unit.label.setAttribute(
          "aria-label",
          `${unit.chat.title}, needs you, waiting ${waited.long}. Open chat`,
        );
        unit.alert.setAttribute(
          "aria-label",
          `Find ${unit.chat.title}, needs you, waiting ${waited.long}`,
        );
      }
      for (const unit of this.units)
        if (!unit.alert)
          unit.label.setAttribute(
            "aria-label",
            `${unit.chat.title}, ${map.statusLabels[unit.chat.status].toLowerCase()}${unit.problem ? ", warning" : ""}. Open chat`,
          );
    }
    // Moves everything to where the camera now shows it.
    draw() {
      const { camera, skin } = this.host,
        { width, height } = camera,
        zoom = camera.now.zoom,
        named = zoom >= skin.sizes.labelZoom;
      // Far out, tags for chats that need you shrink to the waiting time; the list has the names.
      this.labels.classList.toggle("compact", zoom < skin.sizes.farZoom);
      for (const { region, plate } of this.plates) {
        const [x, y] = camera.project(
          region.x + region.w / 2,
          -0.6,
          region.z + region.d + skin.sizes.skirt,
        );
        plate.style.transform = `translate(${x}px,${y}px) translate(-50%,-10%)`;
        plate.hidden = x < -80 || x > width + 80 || y < -20 || y > height + 40;
      }
      const waiting = [],
        tags = [];
      let shown = 0;
      for (const unit of this.units) {
        const [x, y] = camera.project(unit.x, 0.8, unit.z);
        unit.sx = x;
        unit.sy = y;
        unit.onScreen = x > 24 && x < width - 24 && y > 24 && y < height - 24;
        const wanted =
          unit.onScreen &&
          (unit.state === "needs_you" ||
            this.selected.has(unit.chat.id) ||
            this.hovered === unit.chat.id ||
            (named && shown < 80));
        unit.label.hidden = !wanted;
        if (wanted) {
          shown++;
          // Name tags sit above the head; one that would cover another moves up a row.
          let [, top] = camera.project(unit.x, 3.1 * skin.sizes.robot, unit.z);
          while (tags.some((tag) => Math.abs(tag.x - x) < 130 && Math.abs(tag.top - top) < 24))
            top -= 26;
          tags.push({ x, top });
          unit.label.style.transform = `translate(${x}px,${top}px) translate(-50%,-100%)`;
          unit.label.classList.toggle("selected", this.selected.has(unit.chat.id));
        }
        if (unit.alert) {
          unit.alert.hidden = true;
          if (!unit.onScreen) waiting.push(unit);
        }
      }
      // The longest waits get an alert; each sits on the edge nearest its chat.
      const placed = [];
      for (const unit of waiting.sort((a, b) => a.since - b.since).slice(0, MAX_ALERTS)) {
        const left = 96,
          right = width - 96,
          top = 76,
          bottom = height - 190;
        const x = Math.min(right, Math.max(left, unit.sx));
        let y = Math.min(bottom, Math.max(top, unit.sy));
        while (placed.some((other) => Math.abs(other.x - x) < 190 && Math.abs(other.y - y) < 36))
          y += y + 40 > bottom ? -40 * (placed.length + 1) : 40;
        placed.push({ x, y });
        unit.alert.hidden = false;
        unit.alert.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
        unit.arrow.style.transform = `rotate(${Math.atan2(unit.sx - x, y - unit.sy)}rad)`;
      }
    }
    // The unit under a point on screen, if any.
    hit(x, y) {
      const reach = Math.max(14, 16 * this.host.camera.now.zoom);
      let best;
      for (const unit of this.units) {
        const distance = Math.hypot(unit.sx - x, unit.sy - y);
        if (distance < reach && (!best || distance < best.distance)) best = { unit, distance };
      }
      return best?.unit;
    }
    inside(x0, y0, x1, y1) {
      return this.units
        .filter((unit) => unit.sx >= x0 && unit.sx <= x1 && unit.sy >= y0 && unit.sy <= y1)
        .map((unit) => unit.chat.id);
    }
  };
})();
