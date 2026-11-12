// The scene: creates the renderer, asks the builders named in skin.js to build the world,
// and runs the frame loop. It draws at full rate while the camera moves, at a reduced rate
// while only ambient animation plays, and almost never while nothing moves or the view is hidden.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;

  map.Scene = class {
    // host: { open(id), select(ids), moveRegion(id, x, z), reducedMotion, onLevel(name) }
    constructor(host) {
      const skin = map.skin;
      this.skin = skin;
      this.host = host;
      this.canvas = document.querySelector("#map");
      this.parent = this.canvas.parentElement;
      this.renderer = new T.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: "high-performance",
      });
      this.renderer.toneMapping = T.NeutralToneMapping;
      this.renderer.info.autoReset = false; // count every pass of a frame, not just the last
      this.camera = new map.Camera(skin, host.reducedMotion);
      this.selected = new Set();
      this.visible = true;
      this.count = { calls: 0, triangles: 0, frames: 0 };
      this.focusRow = 0.5;
      this.clock = 0;

      const listeners = new Map(),
        colors = new Map(),
        looks = new Map(),
        scene = new T.Scene(),
        root = new T.Group();
      scene.add(root);
      // What every builder receives.
      const world = {
        skin,
        scene,
        root,
        reducedMotion: host.reducedMotion,
        palette: skin.palettes.night,
        far: false,
        parts: {},
        on(name, listener) {
          const list = listeners.get(name) ?? new Set();
          list.add(listener);
          listeners.set(name, list);
          return () => list.delete(listener);
        },
        fire(name, detail) {
          for (const listener of listeners.get(name) ?? []) listener(detail);
        },
        // The palette's color for a state: working, needs_you, review, idle or problem.
        stateColor(name) {
          if (!colors.has(name)) colors.set(name, new T.Color(world.palette.states[name]));
          return colors.get(name);
        },
        // A provider's body color and head detail.
        provider(provider) {
          if (!looks.has(provider.id)) {
            const known = skin.providers[provider.id];
            looks.set(provider.id, {
              color: kit.token(known?.token ?? kit.pick(skin.fallbackTokens, provider.id)),
              detail: known?.detail ?? kit.pick(skin.fallbackDetails, provider.id),
            });
          }
          return looks.get(provider.id);
        },
      };
      this.world = world;
      this.forget = () => {
        colors.clear();
        looks.clear();
      };
      for (const part of ["lighting", "terrain", "buildings", "units", "marks", "effects"])
        world.parts[part] = map.builders[part][skin.builders[part]](world);
      this.post = map.builders.post[skin.builders.post](world, this.renderer, this.camera.lens);
      this.parts = Object.values(world.parts);

      const view = { camera: this.camera, skin };
      this.overlay = new map.Overlay({
        ...view,
        open: host.open,
        select: host.select,
        moveRegion: host.moveRegion,
        focus: (id) => this.focus(id),
        center: (x, z) => this.center(x, z),
      });
      this.minimap = new map.Minimap({ ...view, center: (x, z) => this.center(x, z) });
      this.quality = new map.Quality(skin, this.renderer, (level) => {
        this.post.setLevel(skin.quality[level]);
        host.onLevel(level);
        this.redraw();
      });
      this.post.setLevel(skin.quality[this.quality.level]);
      this.input = new map.Input(this);
      this.resize = new ResizeObserver(() => this.redraw());
      this.resize.observe(this.parent);
      this.theme();
    }

    // Data and selection.
    setData(layout, requests) {
      this.layout = layout;
      for (const part of this.parts) part.setData?.(layout, this.clock);
      this.overlay.setData(layout, requests);
      this.minimap.setData(layout);
      // Until the owner moves the camera, the first seconds of data set the opening view.
      this.firstData ??= this.clock;
      if (!this.touched && layout.regions.length && this.clock < this.firstData + 2) this.home();
      if (!this.loaded && layout.units.length) {
        this.loaded = true;
        if (!this.host.reducedMotion) this.intro = this.clock;
      }
      this.redraw();
    }
    setSelection(ids) {
      this.selected = new Set(ids);
      this.world.parts.marks.setSelection(ids);
      this.overlay.setSelection(ids);
      this.minimap.setSelection(ids);
      this.redraw();
    }
    setHover(unit) {
      if (unit?.chat.id === this.hovered) return;
      this.hovered = unit?.chat.id;
      this.canvas.style.cursor = unit ? "pointer" : "";
      this.world.parts.marks.setHover(unit);
      this.overlay.setHover(unit);
      this.redraw();
    }

    // Camera.
    // The opening view: the whole map when it fits at a readable size, otherwise the busiest island.
    home() {
      const bounds = this.minimap.bounds;
      this.camera.resize(
        Math.max(1, this.parent.clientWidth),
        Math.max(1, this.parent.clientHeight),
      );
      this.camera.frame(bounds);
      if (this.camera.goal.zoom < 0.52) {
        const busiest = this.layout.regions.toSorted(
          (a, b) =>
            this.layout.units.filter((unit) => unit.region === b.id).length -
            this.layout.units.filter((unit) => unit.region === a.id).length,
        )[0];
        this.camera.lookAt(busiest.x + busiest.w / 2, busiest.z + busiest.d / 2, 1);
      } else
        this.camera.lookAt(
          this.camera.goal.x,
          this.camera.goal.z,
          Math.min(1.6, this.camera.goal.zoom),
        );
      this.camera.jump();
    }
    center(x, z) {
      this.touched = true;
      this.camera.lookAt(x, z);
      this.redraw();
    }
    focus(id) {
      const unit = this.layout?.units.find((item) => item.chat.id === id);
      if (!unit) return;
      this.touched = true;
      this.camera.lookAt(unit.x, unit.z, Math.max(1, this.camera.goal.zoom));
      this.redraw();
    }
    // Steps the view by a share of the screen: pan(1, 0) looks right, pan(0, 1) looks down.
    pan(across, down) {
      this.touched = true;
      this.camera.pan(across * this.camera.width * 0.25, down * this.camera.height * 0.25);
      this.redraw();
    }
    scale(factor) {
      this.touched = true;
      this.camera.lookAt(this.camera.goal.x, this.camera.goal.z, this.camera.goal.zoom * factor);
      this.redraw();
    }
    fit() {
      if (!this.layout?.regions.length) return;
      this.touched = true;
      this.camera.frame(this.minimap.bounds);
      this.redraw();
    }

    // Appearance.
    theme() {
      this.forget();
      this.world.palette =
        this.skin.palettes[document.documentElement.dataset.theme === "light" ? "day" : "night"];
      for (const part of this.parts) part.theme?.();
      this.post.theme();
      this.redraw();
    }
    setQuality(choice) {
      this.quality.choose(choice);
    }
    visibility(visible) {
      this.visible = visible;
      if (visible) this.redraw();
      else {
        cancelAnimationFrame(this.frame);
        clearTimeout(this.idle);
        this.frame = 0;
      }
    }

    // The frame loop.
    redraw() {
      this.dirty = true;
      this.request();
    }
    request() {
      clearTimeout(this.idle);
      if (!this.visible || this.frame) return;
      this.frame = requestAnimationFrame((now) => {
        this.frame = 0;
        this.step(now);
      });
    }
    step(now) {
      const { skin, camera, world } = this,
        elapsed = now - (this.drawnAt ?? now - 16),
        delta = Math.min(0.1, elapsed / 1000);
      const ambient =
        this.intro !== undefined || world.parts.units.animated() || world.parts.effects.animated();
      const busy = this.dirty || this.moving || this.interacting || this.intro !== undefined;
      if (!busy && !ambient) {
        // Nothing moves: look again later, in case data changed how things should animate.
        this.idle = setTimeout(() => this.request(), 1000 / skin.timing.idleFps);
        return;
      }
      if (!busy && elapsed < 1000 / skin.timing.ambientFps - 2) {
        this.request();
        return;
      }
      this.drawnAt = now;
      this.clock += delta;
      const width = Math.max(1, this.parent.clientWidth),
        height = Math.max(1, this.parent.clientHeight);
      if (width !== camera.width || height !== camera.height) {
        camera.resize(width, height);
        this.post.setSize(width, height);
      }
      const wasMoving = this.moving;
      this.moving = camera.update(delta);

      // The first load: the camera eases in while buildings and units settle outward from the center.
      let settle;
      if (this.intro !== undefined) {
        const age = this.clock - this.intro,
          { x, z } = camera.now;
        settle = (thing) =>
          kit.pop((age - 0.15 - Math.hypot(thing.x - x, thing.z - z) * 0.012) / 0.45);
        camera.apply((1 - kit.ease(age / skin.timing.intro)) * 0.28);
        world.parts.buildings.settle(settle);
        if (age > skin.timing.intro + 1.2) {
          this.intro = undefined;
          world.parts.buildings.settle();
          settle = undefined;
        }
      }
      const zoom = camera.now.zoom,
        far = zoom < skin.sizes.farZoom;
      if (far !== world.far) {
        world.far = far;
        world.parts.units.setFar(far);
        world.parts.marks.setFar(far);
      }
      const frame = {
        time: this.clock,
        delta,
        settle,
        target: camera.now,
        distance: camera.distance,
        reach: Math.ceil((camera.distance * 0.55) / 20) * 20,
        markScale: Math.min(4.5, Math.max(1, 0.85 / zoom)),
      };
      for (const part of this.parts) part.update(frame);

      // Keep the selection sharp; with none, the middle of the screen.
      const chosen = (this.layout?.units ?? []).filter((unit) => this.selected.has(unit.chat.id));
      let row = 0.5;
      if (chosen.length) {
        const z = chosen.reduce((sum, unit) => sum + unit.z, 0) / chosen.length,
          x = chosen.reduce((sum, unit) => sum + unit.x, 0) / chosen.length;
        row = Math.min(0.9, Math.max(0.1, 1 - camera.project(x, 0, z)[1] / height));
      }
      this.focusRow += (row - this.focusRow) * (world.reducedMotion ? 1 : 1 - Math.exp(-delta * 8));
      const focusing = Math.abs(row - this.focusRow) > 0.003;
      this.post.setFocus(this.focusRow);
      this.post.setZoom(zoom);

      this.renderer.info.reset();
      this.post.render();
      this.count = {
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        frames: this.count.frames + 1,
      };
      if (this.dirty || this.moving || wasMoving || settle) {
        this.overlay.draw();
        this.minimap.draw();
      }
      this.quality.measure(
        elapsed,
        (this.moving && wasMoving) || (settle && this.count.frames > 2),
      );
      this.dirty = focusing;
      this.request();
    }
    // Numbers for tests and tuning.
    stats() {
      return {
        ...this.count,
        level: this.quality.level,
        choice: this.quality.choice,
        passes: this.post.passes(),
        shadows: this.renderer.shadowMap.enabled,
        zoom: this.camera.now.zoom,
        far: this.world.far,
        units: this.layout?.units.length ?? 0,
        animated: this.world.parts.units.animated() || this.world.parts.effects.animated(),
        pixelRatio: this.renderer.getPixelRatio(),
      };
    }
    dispose() {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.idle);
      this.resize.disconnect();
      this.input.dispose();
      for (const part of this.parts) part.dispose();
      this.post.dispose();
      this.renderer.dispose();
    }
  };
})();
