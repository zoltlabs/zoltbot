// The camera: drag to pan, scroll or pinch to zoom, Shift+drag to box-select, and keys for
// moving (arrows), zooming (+ and −) and showing everything (0). Glides unless reduced motion.
(() => {
  const map = window.CommandMap;
  const MIN = 0.45,
    MAX = 2;
  map.Camera = class {
    // host: { stage, world, onMove(), onBox(rect) , reducedMotion }
    constructor(host) {
      this.host = host;
      this.stage = host.stage;
      this.x = 0;
      this.y = 0;
      this.zoom = 1;
      this.moving = false;
      this.dragged = false;
      this.box = document.querySelector("#box");
      this.bind();
    }
    apply() {
      this.host.world.camera.setAttribute(
        "transform",
        `translate(${this.x.toFixed(1)},${this.y.toFixed(1)}) scale(${this.zoom.toFixed(4)})`,
      );
      this.host.onMove();
    }
    // Screen position, inside the stage, of a world point.
    screen(point) {
      return { x: point.x * this.zoom + this.x, y: point.y * this.zoom + this.y };
    }
    // Moves so that a world point sits at a spot on screen (default: a little above center).
    goTo(point, zoom = this.zoom, across = 0.5, down = 0.42) {
      const width = this.stage.clientWidth,
        height = this.stage.clientHeight;
      const goal = {
        x: width * across - point.x * zoom,
        y: height * down - point.y * zoom,
        zoom: Math.min(MAX, Math.max(MIN, zoom)),
      };
      cancelAnimationFrame(this.frame);
      if (this.host.reducedMotion || document.hidden) {
        Object.assign(this, goal);
        this.moving = false;
        this.apply();
        return;
      }
      const from = { x: this.x, y: this.y, zoom: this.zoom },
        start = performance.now();
      this.moving = true;
      const step = (now) => {
        const t = Math.min(1, (now - start) / 450),
          e = 1 - (1 - t) ** 3;
        this.x = from.x + (goal.x - from.x) * e;
        this.y = from.y + (goal.y - from.y) * e;
        this.zoom = from.zoom + (goal.zoom - from.zoom) * e;
        this.apply();
        if (t < 1) this.frame = requestAnimationFrame(step);
        else this.moving = false;
      };
      this.frame = requestAnimationFrame(step);
    }
    // Fits every territory on screen.
    fit() {
      const land = this.host.world.layout.land;
      if (!land.length) return;
      const points = land.map((hex) => this.host.world.at(hex.q, hex.r));
      const xs = points.map((p) => p.x),
        ys = points.map((p) => p.y);
      const width = Math.max(...xs) - Math.min(...xs) + 160,
        height = Math.max(...ys) - Math.min(...ys) + 200;
      const zoom = Math.min(
        1.4,
        Math.max(
          MIN,
          Math.min(this.stage.clientWidth / width, (this.stage.clientHeight - 120) / height),
        ),
      );
      const center = {
        x: (Math.max(...xs) + Math.min(...xs)) / 2,
        y: (Math.max(...ys) + Math.min(...ys)) / 2,
      };
      this.goTo(center, zoom, 0.5, 0.48);
    }
    zoomAt(sx, sy, factor) {
      cancelAnimationFrame(this.frame);
      this.moving = false;
      const zoom = Math.min(MAX, Math.max(MIN, this.zoom * factor));
      const wx = (sx - this.x) / this.zoom,
        wy = (sy - this.y) / this.zoom;
      this.zoom = zoom;
      this.x = sx - wx * zoom;
      this.y = sy - wy * zoom;
      this.apply();
    }
    scale(factor) {
      this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, factor);
    }
    pan(dx, dy) {
      cancelAnimationFrame(this.frame);
      this.moving = false;
      this.x += dx;
      this.y += dy;
      this.apply();
    }
    bind() {
      const stage = this.stage;
      let drag = null;
      stage.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          const box = stage.getBoundingClientRect();
          this.zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.0015));
        },
        { passive: false },
      );
      stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, a, input, textarea, select, .panel-card"))
          return;
        const box = stage.getBoundingClientRect();
        drag = {
          id: event.pointerId,
          sx: event.clientX,
          sy: event.clientY,
          x: this.x,
          y: this.y,
          left: box.left,
          top: box.top,
          select: event.shiftKey,
        };
        this.dragged = false;
      });
      window.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.sx,
          dy = event.clientY - drag.sy;
        if (!this.dragged && Math.abs(dx) + Math.abs(dy) < 5) return;
        if (!this.dragged) stage.setPointerCapture?.(drag.id);
        this.dragged = true;
        if (drag.select) {
          const x = Math.min(event.clientX, drag.sx) - drag.left,
            y = Math.min(event.clientY, drag.sy) - drag.top;
          Object.assign(this.box.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${Math.abs(dx)}px`,
            height: `${Math.abs(dy)}px`,
          });
          this.box.hidden = false;
          return;
        }
        stage.classList.add("dragging");
        cancelAnimationFrame(this.frame);
        this.moving = false;
        this.x = drag.x + dx;
        this.y = drag.y + dy;
        this.apply();
      });
      const end = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        if (drag.select && this.dragged) {
          const rect = this.box.getBoundingClientRect();
          this.box.hidden = true;
          this.host.onBox(rect);
        }
        drag = null;
        stage.classList.remove("dragging");
        // A drag is not a click: swallow the click that follows it.
        if (this.dragged) setTimeout(() => (this.dragged = false), 0);
      };
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      stage.addEventListener(
        "click",
        (event) => {
          if (this.dragged) {
            event.stopPropagation();
            event.preventDefault();
          }
        },
        true,
      );
      window.addEventListener("keydown", (event) => {
        if (
          event.target.matches("input,textarea,select") ||
          event.target.closest(".rail") ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        const step = 80,
          moves = {
            ArrowLeft: [step, 0],
            ArrowRight: [-step, 0],
            ArrowUp: [0, step],
            ArrowDown: [0, -step],
          };
        if (moves[event.key]) {
          event.preventDefault();
          this.pan(...moves[event.key]);
        } else if (event.key === "+" || event.key === "=") this.scale(1.25);
        else if (event.key === "-" || event.key === "_") this.scale(0.8);
        else if (event.key === "0") this.fit();
      });
    }
  };
})();
