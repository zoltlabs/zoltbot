// Effects: soft contact shadows, pools of light at night, and small particles (sparks from
// work, steam from chimneys, confetti when a chat finishes). With reduced motion there are no
// particles at all.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;

  // A fixed-size set of points. Each has a position, a velocity, a color and a lifetime.
  class Particles {
    constructor(parent, capacity, size, texture, additive) {
      this.capacity = capacity;
      this.live = 0;
      this.next = 0;
      this.items = Array.from({ length: capacity }, () => ({ age: 1, life: 0 }));
      this.positions = new Float32Array(capacity * 3);
      this.colors = new Float32Array(capacity * 4);
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.BufferAttribute(this.positions, 3));
      geometry.setAttribute("color", new T.BufferAttribute(this.colors, 4));
      this.points = new T.Points(
        geometry,
        new T.PointsMaterial({
          size,
          map: texture,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          blending: additive ? T.AdditiveBlending : T.NormalBlending,
          toneMapped: false,
        }),
      );
      this.points.frustumCulled = false;
      this.points.visible = false;
      parent.add(this.points);
    }
    emit(x, y, z, vx, vy, vz, life, color, gravity = 0, fade = 1) {
      const item = this.items[this.next];
      this.next = (this.next + 1) % this.capacity;
      Object.assign(item, {
        x,
        y,
        z,
        vx,
        vy,
        vz,
        life,
        age: 0,
        gravity,
        fade,
        r: color.r,
        g: color.g,
        b: color.b,
      });
    }
    update(delta) {
      this.live = 0;
      this.items.forEach((item, index) => {
        if (item.age < item.life) {
          item.age += delta;
          item.vy -= item.gravity * delta;
          item.x += item.vx * delta;
          item.y += item.vy * delta;
          item.z += item.vz * delta;
        }
        const alive = item.age < item.life;
        if (alive) this.live++;
        this.positions.set(alive ? [item.x, item.y, item.z] : [0, -999, 0], index * 3);
        this.colors.set(
          alive ? [item.r, item.g, item.b, item.fade * (1 - item.age / item.life)] : [0, 0, 0, 0],
          index * 4,
        );
      });
      this.points.visible = this.live > 0;
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
    dispose(parent) {
      parent.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
    }
  }

  map.builders.effects.sparks = (world) => {
    const { skin, root } = world,
      dot = kit.dot(0.1),
      disc = new T.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const shade = new kit.Pool(
        root,
        disc,
        new T.MeshBasicMaterial({
          map: dot,
          color: "#000000",
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      ),
      pools = new kit.Pool(
        root,
        disc.clone(),
        new T.MeshBasicMaterial({
          map: dot,
          transparent: true,
          depthWrite: false,
          blending: T.AdditiveBlending,
          toneMapped: false,
        }),
      );
    const sparks = new Particles(root, 400, 0.34, dot, true),
      steam = new Particles(root, 160, 1.5, dot, false),
      confetti = new Particles(root, 320, 0.3, kit.dot(0.8), false);
    const color = new T.Color(),
      random = (spread) => (Math.random() - 0.5) * spread;
    let layout,
      puff = 0;

    const stop = [
      world.on("spark", ({ x, y, z }) => {
        if (world.reducedMotion || world.far) return;
        color.set("#ffd27a").multiplyScalar(Math.max(1.4, world.emit()));
        for (let index = 0; index < 4; index++)
          sparks.emit(
            x,
            y,
            z,
            random(2.4),
            1.6 + Math.random() * 2,
            random(2.4),
            0.35 + Math.random() * 0.25,
            color,
            9,
          );
      }),
      world.on("celebrate", ({ x, z }) => {
        if (world.reducedMotion) return;
        for (let index = 0; index < 36; index++)
          confetti.emit(
            x,
            2.4,
            z,
            random(5),
            4 + Math.random() * 4,
            random(5),
            skin.timing.celebrate * (0.6 + Math.random() * 0.4),
            world.stateColor(["review", "working", "needs_you"][index % 3]),
            11,
          );
      }),
    ];
    function place() {
      if (!layout) return;
      const palette = world.palette,
        buildings = world.parts.buildings.footprints();
      shade.material.opacity = palette.shade;
      shade.begin(layout.units.length + buildings.length);
      layout.units.forEach((unit, index) => {
        shade.put(index, kit.place(unit.x, 0.05, unit.z, { s: 1.35 * skin.sizes.robot }));
      });
      buildings.forEach(([x, z, w, d], index) => {
        shade.put(
          layout.units.length + index,
          kit.place(x, 0.045, z, { sx: w * 0.95, sz: d * 0.95 }),
        );
      });
      shade.end();
      // Light pools: under lamps, in front of lit windows and around units that need you.
      const lights = palette.glow
        ? [
            ...world.parts.terrain.lights().map(([x, z]) => [x, z, 2.4, palette.lampLit]),
            ...world.parts.buildings.lights().map(([x, z]) => [x, z, 2.2, palette.windowLit]),
            ...layout.units
              .filter((unit) => unit.chat.status === "needs_you")
              .map((unit) => [unit.x, unit.z, 4.2, world.stateColor("needs_you")]),
          ]
        : [];
      pools.begin(lights.length);
      lights.forEach(([x, z, radius, tint], index) => {
        pools.put(
          index,
          kit.place(x, 0.06, z, { s: radius }),
          color.set(tint).multiplyScalar(palette.glow),
        );
      });
      pools.end();
      pools.show(lights.length > 0);
    }
    return {
      setData(next) {
        layout = next;
        place();
      },
      theme: place,
      animated: () => sparks.live + steam.live + confetti.live > 0,
      update(frame) {
        if (world.reducedMotion) return;
        // A slow puff of steam from each working chimney.
        puff += frame.delta;
        if (puff > 0.5 && !world.far) {
          puff = 0;
          color.set(world.palette.foam);
          for (const [x, y, z] of world.parts.buildings.chimneys())
            steam.emit(
              x + random(0.2),
              y,
              z + random(0.2),
              random(0.3),
              0.9 + Math.random() * 0.4,
              random(0.3),
              2.2,
              color,
              0,
              0.3,
            );
        }
        sparks.update(frame.delta);
        steam.update(frame.delta);
        confetti.update(frame.delta);
      },
      dispose() {
        for (const off of stop) off();
        shade.dispose();
        pools.dispose();
        for (const system of [sparks, steam, confetti]) system.dispose(root);
        dot.dispose();
      },
    };
  };
})();
