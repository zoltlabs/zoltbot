// Marks: the shapes that show a unit's state from far away, and the selection rings.
//   needs you  a tall beam with a diamond on top and a turning target ring on the ground
//   finished   a pennant on a pole
//   problem    a warning triangle
//   working    (far zoom only) a turning cog
//   selected   a thin broken ring, as in a strategy game; hover shows a fainter full ring
// Each mark is a different shape, so no state depends on color alone.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;
  const flat = (geometry) => geometry.rotateX(-Math.PI / 2);
  const white = new T.Color(1, 1, 1);

  function flag() {
    const cloth = new T.BufferGeometry();
    cloth.setAttribute(
      "position",
      new T.Float32BufferAttribute(
        [0, 2.9, 0, 0, 2.1, 0, 1.25, 2.5, 0, 0, 2.9, 0, 1.25, 2.5, 0, 0, 2.1, 0],
        3,
      ),
    );
    cloth.computeVertexNormals();
    return kit.join([
      kit.paint(
        new T.CylinderGeometry(0.05, 0.05, 3, 6).translate(0, 1.5, 0),
        new T.Color(0.55, 0.55, 0.55),
      ),
      kit.paint(cloth, white),
    ]);
  }
  function warning() {
    const dark = new T.Color(0.05, 0.05, 0.05);
    return kit.join([
      kit
        .paint(
          new T.CylinderGeometry(0.72, 0.72, 0.12, 3).rotateX(Math.PI / 2).rotateZ(Math.PI),
          white,
        )
        .translate(0, 0.1, 0),
      kit.paint(new T.BoxGeometry(0.13, 0.42, 0.06).translate(0, 0.16, 0.09), dark),
      kit.paint(new T.BoxGeometry(0.13, 0.13, 0.06).translate(0, -0.2, 0.09), dark),
    ]);
  }
  // A ring broken into equal arcs with gaps between them.
  function arcs(inner, outer, count, gap) {
    const span = (Math.PI * 2) / count;
    return kit.join(
      Array.from({ length: count }, (_, index) =>
        flat(
          new T.RingGeometry(
            inner,
            outer,
            10,
            1,
            index * span + (span * gap) / 2,
            span * (1 - gap),
          ),
        ),
      ),
    );
  }
  function selectionRing(palette) {
    return kit.join([
      kit.paint(arcs(1.16, 1.27, 4, 0.16), new T.Color(palette.ring)),
      kit.paint(arcs(1.11, 1.32, 4, 0.14).translate(0, -0.01, 0), new T.Color(palette.ringEdge)),
    ]);
  }

  map.builders.marks.tactical = (world) => {
    const { skin, root } = world,
      yaw = skin.camera.yaw,
      pitch = skin.camera.pitch;
    const glow = (options) => new T.MeshBasicMaterial({ toneMapped: false, ...options });
    const pools = {
      beams: new kit.Pool(
        root,
        new T.CylinderGeometry(0.1, 0.22, 1, 8).translate(0, 0.5, 0),
        glow(),
      ),
      diamonds: new kit.Pool(root, new T.OctahedronGeometry(0.78).scale(1, 1.35, 1), glow()),
      alerts: new kit.Pool(root, arcs(1.45, 1.62, 3, 0.2), glow({ side: T.DoubleSide })),
      // A soft filled circle under the rings.
      discs: new kit.Pool(
        root,
        flat(new T.CircleGeometry(1, 40)),
        glow({ transparent: true, opacity: 0.16, depthWrite: false }),
      ),
      flags: new kit.Pool(root, flag(), glow({ vertexColors: true, side: T.DoubleSide })),
      warnings: new kit.Pool(root, warning(), glow({ vertexColors: true })),
      cogs: new kit.Pool(
        root,
        new T.CylinderGeometry(0.5, 0.5, 0.22, 6),
        new T.MeshStandardMaterial({ roughness: 0.5, flatShading: true }),
      ),
      rings: new kit.Pool(root, selectionRing(world.palette), glow({ vertexColors: true })),
    };
    const hover = new T.Mesh(
      flat(new T.RingGeometry(1.1, 1.24, 40)),
      glow({ transparent: true, opacity: 0.7, depthWrite: false }),
    );
    hover.position.y = 0.07;
    hover.visible = false;
    root.add(hover);
    const color = new T.Color();
    let units = [],
      selected = new Set(),
      far = false;
    const raised = new Map(); // chat id: when its flag went up

    return {
      setData(layout, time) {
        units = layout.units.map((unit) => ({ ...unit, ...map.unitState(unit.chat) }));
        for (const unit of units)
          if (unit.state !== "review") raised.delete(unit.chat.id);
          else if (!raised.has(unit.chat.id)) raised.set(unit.chat.id, this.loaded ? time : -99);
        this.loaded = true;
      },
      setSelection(ids) {
        selected = new Set(ids);
      },
      setHover(unit) {
        hover.visible = !!unit && !selected.has(unit.chat.id);
        if (unit) hover.position.set(unit.x, 0.07, unit.z);
      },
      setFar(value) {
        far = value;
      },
      theme() {
        pools.rings.geometry.dispose();
        pools.rings.geometry = pools.rings.mesh.geometry = selectionRing(world.palette);
        hover.material.color.set(world.palette.ring);
      },
      update(frame) {
        const palette = world.palette,
          still = world.reducedMotion,
          S = skin.sizes.robot,
          k = frame.markScale, // grows as the camera pulls back, so marks stay readable
          wide = Math.max(1, k * 0.8) * S, // ground rings
          top = (far ? 1.9 * k * 0.8 : 2.5) * S; // just above a unit's head
        const grown = (unit) => frame.settle?.(unit) ?? 1;
        const needs = units.filter((unit) => unit.state === "needs_you"),
          done = units.filter((unit) => unit.state === "review"),
          broken = units.filter((unit) => unit.problem),
          busy = far ? units.filter((unit) => unit.state === "working" && !unit.problem) : [],
          chosen = units.filter((unit) => selected.has(unit.chat.id));

        // Needs you: the loudest mark. The beam and diamond glow even by day; the rings on the
        // ground are plain color so they do not flood the scene with light.
        const ground = world.stateColor("needs_you");
        const attention = color
            .copy(world.stateColor("needs_you"))
            .multiplyScalar(world.emit(1.5))
            .clone(),
          pulse = still
            ? 0.5
            : (Math.sin((frame.time / skin.timing.beaconPulse) * Math.PI * 2) + 1) / 2,
          height = skin.sizes.beacon * k;
        pools.beams.begin(needs.length);
        pools.diamonds.begin(needs.length);
        pools.alerts.begin(needs.length * 2);
        pools.discs.begin(needs.length);
        needs.forEach((unit, index) => {
          const grow = grown(unit);
          pools.beams.put(
            index,
            kit.place(unit.x, top, unit.z, { sx: k, sz: k, sy: height * grow }),
            attention,
          );
          pools.diamonds.put(
            index,
            kit.place(unit.x, top + height * grow + 0.6 * k + pulse * 0.3 * k, unit.z, {
              s: k * grow,
              ry: still ? yaw : frame.time * 1.2,
            }),
            attention,
          );
          pools.discs.put(
            index,
            kit.place(unit.x, 0.06, unit.z, { s: grow * wide * 1.45 }),
            ground,
          );
          pools.alerts.put(index * 2, kit.place(unit.x, 0.08, unit.z, { s: grow * wide }), ground);
          pools.alerts.put(
            index * 2 + 1,
            kit.place(unit.x, 0.07, unit.z, {
              s: grow * wide * (1.3 + pulse * 0.18),
              ry: still ? 0.5 : -frame.time * 0.7,
            }),
            ground,
          );
        });

        // Finished: a flag, raised once and then still.
        pools.flags.begin(done.length);
        done.forEach((unit, index) => {
          const rise = still ? 1 : kit.pop((frame.time - raised.get(unit.chat.id)) / 0.5);
          pools.flags.put(
            index,
            kit.place(unit.x - (far ? 0 : 1.05 * S), 0, unit.z - 0.2, {
              ry: yaw,
              s: k * 1.3 * grown(unit),
              sy: k * 1.3 * rise * grown(unit),
            }),
            world.stateColor("review"),
          );
        });

        // Problem: a warning triangle above the head, turned to face the camera.
        pools.warnings.begin(broken.length);
        const warn = color
          .copy(world.stateColor("problem"))
          .multiplyScalar(world.emit(1) > 1 ? palette.emit * 0.6 : 1)
          .clone();
        broken.forEach((unit, index) => {
          pools.warnings.put(
            index,
            kit.place(unit.x + (unit.state === "needs_you" ? 1.2 * k : 0), top + 0.8 * k, unit.z, {
              ry: yaw,
              rx: -pitch * 0.6,
              s: k * 1.15 * grown(unit),
            }),
            warn,
          );
        });

        // Far zoom only: working units carry a turning cog.
        pools.cogs.begin(busy.length);
        busy.forEach((unit, index) => {
          pools.cogs.put(
            index,
            kit.place(unit.x, top + 0.55 * k, unit.z, {
              s: k * 0.9,
              ry: still ? 0 : frame.time * 1.5 + unit.x,
            }),
            world.stateColor("working"),
          );
        });

        pools.rings.begin(chosen.length);
        chosen.forEach((unit, index) => {
          pools.rings.put(index, kit.place(unit.x, 0.09, unit.z, { s: wide }));
        });
        for (const pool of Object.values(pools)) pool.end();
        hover.scale.setScalar(wide);
      },
      dispose() {
        for (const pool of Object.values(pools)) pool.dispose();
        root.remove(hover);
        hover.geometry.dispose();
        hover.material.dispose();
      },
    };
  };
})();
