// Units: each chat is a small robot. Its body color and the detail on its head come from the
// provider. Its pose shows its state: hammering (working), arms up (needs you), standing
// (finished), sitting with lights off (idle) or leaning (problem).
//
// To replace the model, copy this file, register your builder under another name
// (CommandMap.builders.units.<name>) and name it in skin.js. A units builder must return
// setData, update, setFar, animated, theme and dispose, as this one does.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;
  const box = (w, h, d, segments, radius) => new T.RoundedBoxGeometry(w, h, d, segments, radius);
  const rod = (radius, height, sides = 6) => new T.CylinderGeometry(radius, radius, height, sides);

  // Head details, in the head's own frame (the head is 1.15 wide, 0.8 tall, centered at 0).
  const details = {
    antenna: () =>
      kit.join([
        rod(0.035, 0.5).translate(0, 0.65, 0),
        new T.SphereGeometry(0.14, 8, 6).translate(0, 0.95, 0),
      ]),
    twin: () =>
      kit.join(
        [-1, 1].flatMap((side) => [
          rod(0.035, 0.5)
            .rotateZ(-0.45 * side)
            .translate(0.22 * side, 0.6, 0),
          new T.SphereGeometry(0.09, 6, 4).translate(0.33 * side, 0.84, 0),
        ]),
      ),
    fin: () => box(0.14, 0.38, 0.8, 1, 0.06).translate(0, 0.56, 0),
    ears: () =>
      kit.join(
        [-1, 1].map((side) =>
          rod(0.24, 0.16, 8)
            .rotateZ(Math.PI / 2)
            .translate(0.65 * side, 0.02, 0),
        ),
      ),
    halo: () => new T.TorusGeometry(0.46, 0.055, 4, 14).rotateX(Math.PI / 2).translate(0, 0.72, 0),
    hat: () =>
      kit.join([
        rod(0.34, 0.36, 8).translate(0, 0.6, 0),
        rod(0.52, 0.06, 10).translate(0, 0.43, 0),
      ]),
    brim: () =>
      kit.join([
        new T.SphereGeometry(0.5, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2)
          .scale(1, 0.5, 0.85)
          .translate(0, 0.4, 0),
        box(0.72, 0.06, 0.45, 1, 0.02).translate(0, 0.42, 0.58),
      ]),
    dome: () =>
      new T.SphereGeometry(0.36, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.4, 0),
  };

  // Target pose for a state. Angles are radians; negative arm angles swing forward and up.
  function pose(state, problem, time, skin, still) {
    if (state === "needs_you") {
      const wave = still ? 0 : Math.sin(time * 2.4) * 0.16;
      return {
        sit: 0,
        lean: -0.06,
        roll: 0,
        head: -0.38,
        tilt: 0,
        left: -2.7 + wave,
        right: -2.7 - wave,
      };
    }
    if (problem)
      return {
        sit: -0.05,
        lean: 0.05,
        roll: 0.22,
        head: 0.12,
        tilt: -0.3,
        left: -0.1,
        right: -0.9,
      };
    if (state === "working") {
      const beat = still ? 0.4 : (time / skin.timing.work) % 1,
        raise = beat < 0.65 ? kit.ease(beat / 0.65) : 1 - ((beat - 0.65) / 0.35) ** 0.6;
      return {
        sit: still ? 0 : Math.sin(time * 5) * 0.025,
        lean: 0.1,
        roll: 0,
        head: 0.18,
        tilt: 0,
        left: -0.5,
        right: -0.7 - raise * 1.6,
      };
    }
    if (state === "review")
      return { sit: 0, lean: 0, roll: 0, head: -0.08, tilt: 0, left: -0.1, right: -0.1 };
    return { sit: -0.2, lean: 0.14, roll: 0, head: 0.3, tilt: 0, left: 0.05, right: 0.05 }; // idle
  }

  map.builders.units.robots = (world) => {
    const { skin, root } = world,
      S = skin.sizes.robot,
      yaw = skin.camera.yaw;
    const solid = (options) => new T.MeshStandardMaterial({ roughness: 0.6, ...options });
    const parts = {
      treads: new kit.Pool(root, new T.BoxGeometry(1.5, 0.45, 1.25), solid({ roughness: 0.9 }), {
        cast: true,
      }),
      bodies: new kit.Pool(root, box(1.25, 1.05, 1.0, 1, 0.2), solid(), {
        cast: true,
        receive: true,
      }),
      heads: new kit.Pool(root, box(1.15, 0.8, 0.95, 1, 0.2), solid({ roughness: 0.45 }), {
        cast: true,
      }),
      visors: new kit.Pool(
        root,
        new T.BoxGeometry(0.82, 0.3, 0.12),
        new T.MeshBasicMaterial({ toneMapped: false }),
      ),
      arms: new kit.Pool(root, new T.BoxGeometry(0.26, 0.78, 0.3).translate(0, -0.3, 0), solid()),
    };
    const hats = Object.fromEntries(
      Object.entries(details).map(([name, build]) => [name, new kit.Pool(root, build(), solid())]),
    );
    // Far away, a robot becomes one simple pawn.
    const pawns = new kit.Pool(
      root,
      kit.join([
        new T.CylinderGeometry(0.3, 0.72, 1.4, 10).translate(0, 0.7, 0),
        new T.SphereGeometry(0.5, 10, 8).translate(0, 1.75, 0),
      ]),
      solid(),
      { cast: true },
    );
    pawns.show(false);
    const memory = new Map(), // per chat: smoothed pose and when its state last changed
      base = new T.Matrix4(),
      torso = new T.Matrix4(),
      skull = new T.Matrix4(),
      visor = new T.Color();
    let units = [],
      far = false;

    function count() {
      const used = Object.fromEntries(Object.keys(hats).map((name) => [name, 0]));
      for (const unit of units) unit.hat = used[unit.look.detail]++;
      for (const [name, pool] of Object.entries(hats)) pool.begin(far ? 0 : used[name]);
      for (const [name, pool] of Object.entries(parts))
        pool.begin(far ? 0 : units.length * (name === "arms" || name === "visors" ? 2 : 1));
      pawns.begin(far ? units.length : 0);
      pawns.show(far);
    }
    return {
      setData(layout, time) {
        const seen = new Set();
        units = layout.units.map((unit) => {
          const { state, problem } = map.unitState(unit.chat),
            id = unit.chat.id;
          let mind = memory.get(id);
          if (!mind) {
            mind = { phase: kit.unit(id) * 10, turn: (kit.unit(`${id}t`) - 0.5) * 0.5, born: time };
            memory.set(id, mind);
          } else if (mind.state !== state) {
            mind.since = time;
            if (state === "review") world.fire("celebrate", { x: unit.x, z: unit.z });
          }
          mind.state = state;
          seen.add(id);
          return { ...unit, state, problem, mind, look: world.provider(unit.chat.provider) };
        });
        for (const id of memory.keys()) if (!seen.has(id)) memory.delete(id);
        count();
      },
      setFar(value) {
        if (far === value) return;
        far = value;
        count();
      },
      // True while any robot is moving, so the scene keeps drawing frames.
      animated: () =>
        !world.reducedMotion &&
        units.some(
          (unit) => unit.state === "working" || unit.state === "needs_you" || unit.mind.hop > 0,
        ),
      theme() {},
      update(frame) {
        const palette = world.palette,
          still = world.reducedMotion,
          blend = still ? 1 : 1 - Math.exp(-frame.delta * 12);
        units.forEach((unit, index) => {
          const mind = unit.mind,
            time = frame.time + mind.phase;
          const grow =
            S * (frame.settle?.(unit) ?? (still ? 1 : kit.pop((frame.time - mind.born) / 0.4)));
          if (far) {
            const k = frame.markScale * grow * 0.8;
            pawns.put(
              index,
              kit.place(unit.x, 0, unit.z, { s: k, sy: unit.state === "idle" ? k * 0.72 : k }),
              unit.look.color,
            );
            return;
          }
          const goal = pose(unit.state, unit.problem, time, skin, still);
          mind.pose ??= { ...goal };
          const now = mind.pose;
          for (const key in goal) now[key] += (goal[key] - now[key]) * blend;
          // A short hop when a chat finishes.
          const since = frame.time - (mind.since ?? -99);
          mind.hop =
            !still && unit.state === "review" && since < skin.timing.celebrate
              ? Math.abs(Math.sin(since * 9)) * 0.45 * (1 - since / skin.timing.celebrate)
              : 0;
          base.copy(kit.place(unit.x, mind.hop, unit.z, { ry: yaw + mind.turn, s: grow }));
          parts.treads.put(index, kit.under(base, 0, 0.225, 0), visor.set(palette.tread));
          torso.copy(kit.under(base, 0, 1.0 + now.sit, 0, { rx: now.lean, rz: now.roll }));
          parts.bodies.put(index, torso, unit.look.color);
          parts.arms.put(
            index * 2,
            kit.under(torso, -0.77, 0.3, 0, { rx: now.left }),
            unit.look.color,
          );
          parts.arms.put(
            index * 2 + 1,
            kit.under(torso, 0.77, 0.3, 0, { rx: now.right }),
            unit.look.color,
          );
          skull.copy(kit.under(torso, 0, 0.99, 0.02, { rx: now.head, rz: now.tilt }));
          parts.heads.put(index, skull, visor.set(palette.shell));
          if (unit.state === "idle" && !unit.problem) visor.set(palette.visorOff);
          else
            visor
              .copy(
                world.stateColor(
                  unit.problem && unit.state !== "needs_you" ? "problem" : unit.state,
                ),
              )
              .multiplyScalar(palette.emit);
          parts.visors.put(index * 2, kit.under(skull, 0, 0.02, 0.45), visor);
          // A small chest light repeats the visor's color, so the state reads from further off.
          parts.visors.put(
            index * 2 + 1,
            kit.under(torso, 0, 0.08, 0.47, { sx: 0.42, sy: 0.9 }),
            visor,
          );
          hats[unit.look.detail].put(unit.hat, skull, unit.look.color);
          // Each hammer blow throws a spark.
          if (unit.state === "working" && !unit.problem && !still) {
            const blow = Math.floor(time / skin.timing.work + 0.35);
            if (mind.blow !== undefined && blow !== mind.blow)
              world.fire("spark", {
                x:
                  unit.x + (Math.cos(yaw + mind.turn) * 0.75 + Math.sin(yaw + mind.turn) * 0.7) * S,
                y: 0.95 * S,
                z:
                  unit.z +
                  (-Math.sin(yaw + mind.turn) * 0.75 + Math.cos(yaw + mind.turn) * 0.7) * S,
              });
            mind.blow = blow;
          }
        });
        for (const pool of [...Object.values(parts), ...Object.values(hats), pawns]) pool.end();
      },
      dispose() {
        for (const pool of [...Object.values(parts), ...Object.values(hats), pawns]) pool.dispose();
      },
    };
  };
})();
