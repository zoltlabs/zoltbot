(() => {
  const T = window.THREE;
  window.CommandMapScene = class {
    constructor(open, select) {
      this.open = open;
      this.select = select;
      this.selected = new Set();
      this.visible = true;
      this.frame = 0;
      this.zoom = 1;
      this.cx = 10;
      this.cz = 10;
      this.canvas = document.querySelector("#map");
      this.parent = this.canvas.parentElement;
      this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.scene = new T.Scene();
      this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
      this.group = new T.Group();
      this.scene.add(this.group);
      this.boxGeometry = new T.BoxGeometry(1, 1, 1);
      this.edgeGeometry = new T.EdgesGeometry(this.boxGeometry);
      this.edgeMaterial = new T.LineBasicMaterial();
      this.unitGeometry = new T.BoxGeometry(1.6, 2.4, 1.6);
      this.materials = new Map();
      this.units = [];
      this.resize = new ResizeObserver(() => this.draw());
      this.resize.observe(this.parent);
      this.listen();
      this.theme();
    }
    color(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    material(name) {
      if (!this.materials.has(name))
        this.materials.set(name, new T.MeshBasicMaterial({ color: this.color(name) }));
      return this.materials.get(name);
    }
    theme() {
      for (const [name, material] of this.materials) material.color.set(this.color(name));
      this.edgeMaterial.color.set(this.color("--zb-border-control"));
      this.renderer.setClearColor(this.color("--zb-bg-canvas"));
      this.draw();
    }
    box(x, z, w, d, height, token, geometry = this.boxGeometry) {
      const mesh = new T.Mesh(geometry, this.material(token));
      mesh.position.set(x, height / 2, z);
      if (geometry === this.boxGeometry) mesh.scale.set(w, height, d);
      this.group.add(mesh);
      return mesh;
    }
    setData(layout) {
      this.layout = layout;
      this.group.clear();
      this.units = [];
      const regions = document.querySelector("#regions"),
        labels = document.querySelector("#units"),
        alerts = document.querySelector("#alerts");
      regions.replaceChildren();
      labels.replaceChildren();
      alerts.replaceChildren();
      for (const region of layout.regions) {
        const plate = this.box(
          region.x + region.w / 2,
          region.z + region.d / 2,
          region.w,
          region.d,
          0.4,
          "--zb-bg-raised",
        );
        const outline = new T.LineSegments(this.edgeGeometry, this.edgeMaterial);
        outline.position.copy(plate.position);
        outline.scale.copy(plate.scale);
        this.group.add(outline);
        const label = document.createElement("button");
        label.type = "button";
        label.className = "region";
        label.textContent = region.name;
        label.onclick = () => this.center(region.x + region.w / 2, region.z + region.d / 2);
        regions.append(label);
        region.label = label;
      }
      for (const base of layout.bases) this.box(base.x, base.z, 4, 4, 1.1, "--zb-border-control");
      const tokens = {
        working: "--zb-accent-text",
        needs_you: "--zb-attention",
        review: "--zb-ok",
        idle: "--zb-text-secondary",
        later: "--zb-text-secondary",
      };
      const marks = { working: "◌", needs_you: "▲", review: "⚑", idle: "Ⅱ", later: "Ⅱ" };
      for (const unit of layout.units) {
        const chat = unit.chat;
        this.box(unit.x, unit.z, 1, 1, 2.4, tokens[chat.status], this.unitGeometry);
        const label = document.createElement("button");
        label.type = "button";
        label.className = "unit";
        label.dataset.chat = chat.id;
        label.dataset.status = chat.status;
        label.textContent = `${marks[chat.status]} ${chat.title}${chat.problem || chat.lastTurn?.status === "failed" ? " ⚠" : ""}`;
        label.setAttribute(
          "aria-label",
          `${chat.title}, ${chat.status.replaceAll("_", " ")}. Open chat`,
        );
        label.onclick = () => this.open(chat.id);
        labels.append(label);
        const alert = document.createElement("button");
        alert.type = "button";
        alert.className = "edge-alert";
        alert.textContent = `↗ ${chat.title}: Needs you`;
        alert.setAttribute("aria-label", `Find ${chat.title}, needs you`);
        alert.onclick = () => {
          this.focus(chat.id);
          this.select([chat.id]);
        };
        alerts.append(alert);
        this.units.push({ ...unit, label, alert, sx: 0, sy: 0 });
      }
      this.draw();
    }
    setSelection(ids) {
      this.selected = new Set(ids);
      for (const unit of this.units)
        unit.label.classList.toggle("selected", this.selected.has(unit.chat.id));
      this.draw();
    }
    center(x, z) {
      this.cx = x;
      this.cz = z;
      this.draw();
    }
    focus(id) {
      const unit = this.units.find((item) => item.chat.id === id);
      if (unit) this.center(unit.x, unit.z);
    }
    scale(factor) {
      this.zoom = Math.min(4, Math.max(0.3, this.zoom * factor));
      this.draw();
    }
    project(x, z, height = 3) {
      const value = new T.Vector3(x, height, z).project(this.camera);
      return [((value.x + 1) / 2) * this.width, ((1 - value.y) / 2) * this.height];
    }
    draw() {
      if (!this.visible || !this.renderer || this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
    render() {
      this.width = Math.max(1, this.parent.clientWidth);
      this.height = Math.max(1, this.parent.clientHeight);
      this.renderer.setSize(this.width, this.height, false);
      const ratio = this.width / this.height;
      Object.assign(this.camera, {
        left: -20 * ratio,
        right: 20 * ratio,
        top: 20,
        bottom: -20,
        zoom: this.zoom,
      });
      this.camera.position.set(this.cx + 45, 90, this.cz + 75);
      this.camera.lookAt(this.cx, 0, this.cz);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
      for (const region of this.layout?.regions ?? []) {
        const [x, y] = this.project(region.x + region.w / 2, region.z, 1);
        region.label.style.transform = `translate(${x}px,${y}px)`;
      }
      for (const unit of this.units) {
        const [x, y] = this.project(unit.x, unit.z);
        unit.sx = x;
        unit.sy = y;
        const outside = x < 20 || x > this.width - 20 || y < 20 || y > this.height - 20;
        unit.label.hidden = outside;
        unit.label.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
        unit.alert.hidden = unit.chat.status !== "needs_you" || !outside;
        unit.alert.style.transform = `translate(${Math.min(this.width - 80, Math.max(80, x))}px,${Math.min(this.height - 140, Math.max(40, y))}px) translate(-50%,-50%)`;
      }
      this.minimap();
    }
    minimap() {
      const canvas = document.querySelector("#mini"),
        context = canvas.getContext("2d");
      canvas.width = 160;
      canvas.height = 110;
      const regions = this.layout?.regions ?? [];
      this.bounds = {
        x: Math.max(40, ...regions.map((region) => region.x + region.w + 10)),
        z: Math.max(40, ...regions.map((region) => region.z + region.d + 10)),
      };
      context.fillStyle = this.color("--zb-bg-page");
      context.fillRect(0, 0, 160, 110);
      context.strokeStyle = this.color("--zb-text-secondary");
      for (const region of regions)
        context.strokeRect(
          (region.x / this.bounds.x) * 160,
          (region.z / this.bounds.z) * 110,
          (region.w / this.bounds.x) * 160,
          (region.d / this.bounds.z) * 110,
        );
      for (const unit of this.units) {
        context.fillStyle = this.color(
          unit.chat.status === "needs_you" ? "--zb-attention" : "--zb-text",
        );
        context.fillRect(
          (unit.x / this.bounds.x) * 160 - 2,
          (unit.z / this.bounds.z) * 110 - 2,
          4,
          4,
        );
      }
      const ray = new T.Raycaster(),
        plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
      context.beginPath();
      [
        [-1, 1],
        [1, 1],
        [1, -1],
        [-1, -1],
      ].forEach(([x, y], index) => {
        ray.setFromCamera(new T.Vector2(x, y), this.camera);
        const point = ray.ray.intersectPlane(plane, new T.Vector3());
        if (point) {
          const mx = (point.x / this.bounds.x) * 160,
            mz = (point.z / this.bounds.z) * 110;
          if (index) context.lineTo(mx, mz);
          else context.moveTo(mx, mz);
        }
      });
      context.closePath();
      context.stroke();
    }
    listen() {
      let start;
      this.canvas.oncontextmenu = (event) => event.preventDefault();
      this.canvas.onpointerdown = (event) => {
        this.canvas.setPointerCapture(event.pointerId);
        start = {
          x: event.offsetX,
          y: event.offsetY,
          cx: this.cx,
          cz: this.cz,
          pan: event.button !== 0 || event.pointerType === "touch",
        };
      };
      this.canvas.onpointermove = (event) => {
        if (!start) return;
        const dx = event.offsetX - start.x,
          dy = event.offsetY - start.y;
        if (start.pan) this.center(start.cx - dx / this.zoom / 12, start.cz - dy / this.zoom / 12);
        else {
          const box = document.querySelector("#box");
          box.hidden = false;
          Object.assign(box.style, {
            left: `${Math.min(start.x, event.offsetX)}px`,
            top: `${Math.min(start.y, event.offsetY)}px`,
            width: `${Math.abs(dx)}px`,
            height: `${Math.abs(dy)}px`,
          });
        }
      };
      this.canvas.onpointerup = (event) => {
        if (!start) return;
        if (!start.pan && Math.hypot(event.offsetX - start.x, event.offsetY - start.y) > 4)
          this.select(
            this.units
              .filter(
                (unit) =>
                  unit.sx >= Math.min(start.x, event.offsetX) &&
                  unit.sx <= Math.max(start.x, event.offsetX) &&
                  unit.sy >= Math.min(start.y, event.offsetY) &&
                  unit.sy <= Math.max(start.y, event.offsetY),
              )
              .map((unit) => unit.chat.id),
          );
        else if (!start.pan) {
          const hit = this.units.find(
            (unit) => Math.hypot(unit.sx - event.offsetX, unit.sy - event.offsetY) < 25,
          );
          if (hit) this.open(hit.chat.id);
        }
        start = undefined;
        document.querySelector("#box").hidden = true;
      };
      this.canvas.onpointercancel = () => {
        start = undefined;
        document.querySelector("#box").hidden = true;
      };
      this.canvas.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) this.scale(Math.exp(-event.deltaY * 0.01));
          else
            this.center(
              this.cx + event.deltaX / 12 / this.zoom,
              this.cz + event.deltaY / 12 / this.zoom,
            );
        },
        { passive: false },
      );
      const mini = document.querySelector("#mini");
      mini.onpointerdown = (event) => {
        this.center(
          (event.offsetX / mini.clientWidth) * this.bounds.x,
          (event.offsetY / mini.clientHeight) * this.bounds.z,
        );
      };
    }
    visibility(visible) {
      this.visible = visible;
      if (!visible) {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      } else this.draw();
    }
    dispose() {
      cancelAnimationFrame(this.frame);
      this.resize.disconnect();
      this.renderer.dispose();
      this.boxGeometry.dispose();
      this.unitGeometry.dispose();
      this.edgeGeometry.dispose();
      this.edgeMaterial.dispose();
      for (const material of this.materials.values()) material.dispose();
    }
  };
})();
