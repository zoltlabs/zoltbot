// The minimap: every island and unit at a glance, with the camera's view outlined.
// Click or drag on it to move the camera. Each state has its own shape, as on the map.
(() => {
  const map = window.CommandMap;
  const W = 184,
    H = 124,
    PAD = 8;

  map.Minimap = class {
    constructor(host) {
      this.host = host; // { camera, center(x, z) }
      this.canvas = document.querySelector("#mini");
      this.context = this.canvas.getContext("2d");
      this.layout = { regions: [], units: [] };
      this.selected = new Set();
      const move = (event) => {
        const { scale, left, top } = this.fit;
        this.host.center((event.offsetX - left) / scale, (event.offsetY - top) / scale);
      };
      this.canvas.onpointerdown = (event) => {
        this.canvas.setPointerCapture(event.pointerId);
        move(event);
      };
      this.canvas.onpointermove = (event) => {
        if (event.buttons) move(event);
      };
    }
    setData(layout) {
      this.layout = layout;
      const regions = layout.regions,
        x0 = Math.min(...regions.map((region) => region.x), 0) - 6,
        z0 = Math.min(...regions.map((region) => region.z), 0) - 6,
        x1 = Math.max(...regions.map((region) => region.x + region.w), 30) + 6,
        z1 = Math.max(...regions.map((region) => region.z + region.d), 20) + 6;
      const scale = Math.min((W - PAD * 2) / (x1 - x0), (H - PAD * 2) / (z1 - z0));
      // World (x, z) maps to canvas (x * scale + left, z * scale + top).
      this.fit = {
        scale,
        left: (W - (x1 - x0) * scale) / 2 - x0 * scale,
        top: (H - (z1 - z0) * scale) / 2 - z0 * scale,
      };
      this.bounds = { x: x0 + 6, z: z0 + 6, w: x1 - x0 - 12, d: z1 - z0 - 12 };
    }
    setSelection(ids) {
      this.selected = new Set(ids);
    }
    token(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    draw() {
      const { canvas, context } = this,
        ratio = Math.min(2, window.devicePixelRatio || 1);
      if (!this.fit) return;
      if (canvas.width !== W * ratio) {
        canvas.width = W * ratio;
        canvas.height = H * ratio;
      }
      const { scale, left, top } = this.fit,
        px = (x) => x * scale + left,
        pz = (z) => z * scale + top;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, W, H);
      context.fillStyle = this.token("--zb-bg-active");
      context.strokeStyle = this.token("--zb-border-strong");
      context.lineWidth = 1;
      for (const region of this.layout.regions) {
        context.beginPath();
        context.roundRect(px(region.x), pz(region.z), region.w * scale, region.d * scale, 3);
        context.fill();
        context.stroke();
      }
      const colors = {
        working: this.token("--zb-accent-text"),
        needs_you: this.token("--zb-attention"),
        review: this.token("--zb-ok"),
        idle: this.token("--zb-text-muted"),
        problem: this.token("--zb-warn"),
      };
      // Quiet states first, so a chat that needs the owner is never drawn over.
      const order = { idle: 0, working: 1, review: 2, problem: 3, needs_you: 4 };
      const units = this.layout.units
        .map((unit) => {
          const { state, problem } = map.unitState(unit.chat);
          return { unit, kind: problem && state !== "needs_you" ? "problem" : state };
        })
        .sort((a, b) => order[a.kind] - order[b.kind]);
      // Marks shrink on a big map so they do not run together; "needs you" stays the largest.
      const r = Math.min(3.5, Math.max(1.3, scale * 1.4));
      for (const { unit, kind } of units) {
        const x = px(unit.x),
          y = pz(unit.z);
        context.fillStyle = colors[kind];
        context.beginPath();
        if (kind === "needs_you") {
          const big = Math.max(3.2, r * 1.4);
          context.moveTo(x, y - big * 1.25);
          context.lineTo(x + big, y);
          context.lineTo(x, y + big * 1.25);
          context.lineTo(x - big, y);
        } else if (kind === "problem") {
          context.moveTo(x, y - r);
          context.lineTo(x + r, y + r * 0.9);
          context.lineTo(x - r, y + r * 0.9);
        } else if (kind === "review") {
          context.moveTo(x - r * 0.7, y - r);
          context.lineTo(x + r, y - r * 0.3);
          context.lineTo(x - r * 0.7, y + r * 0.45);
        } else if (kind === "working") context.arc(x, y, r * 0.65, 0, Math.PI * 2);
        else context.rect(x - r * 0.6, y - r * 0.3, r * 1.2, r * 0.6);
        context.fill();
        if (this.selected.has(unit.chat.id)) {
          context.strokeStyle = this.token("--zb-text");
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(x, y, 5.5, 0, Math.PI * 2);
          context.stroke();
        }
      }
      // The part of the ground the camera shows.
      const corners = this.host.camera.corners();
      if (corners.every(Boolean)) {
        context.strokeStyle = this.token("--zb-text");
        context.lineWidth = 1.5;
        context.beginPath();
        corners.forEach((point, index) => {
          index
            ? context.lineTo(px(point.x), pz(point.z))
            : context.moveTo(px(point.x), pz(point.z));
        });
        context.closePath();
        context.stroke();
      }
    }
  };
})();
