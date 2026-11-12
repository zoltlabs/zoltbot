// Units: each chat is a small walker. Its frame is steel; its shoulders and chest plate carry
// the provider's color, and one piece of equipment on top differs by provider. Its pose shows
// its state: welding (working), braced with visor lit (needs you), standing (finished),
// crouched with lights off (idle) or slumped to one side (problem).
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
  // `sit` lowers the legs, `lean` and `roll` tip the torso, `head` and `tilt` turn the sensor.
  function pose(state, problem, time, skin, still) {
    if (state === "needs_you")
      return { sit: 0, lean: -0.05, roll: 0, head: -0.3, tilt: 0, left: -0.5, right: -0.5 };
    if (problem)
      return { sit: -0.12, lean: 0.1, roll: 0.2, head: 0.2, tilt: -0.25, left: 0.1, right: -0.4 };
    if (state === "working") {
      // The tool arm makes short passes forward and back.
      const pass = still ? 0.5 : (Math.sin((time / skin.timing.work) * Math.PI * 2) + 1) / 2;
      return {
        sit: -0.06,
        lean: 0.16,
        roll: 0,
        head: 0.25,
        tilt: 0,
        left: -0.3,
        right: -1.0 - pass * 0.35,
      };
    }
    if (state === "review")
      return { sit: 0, lean: 0, roll: 0, head: 0, tilt: 0, left: 0, right: 0 };
    return { sit: -0.3, lean: 0.2, roll: 0, head: 0.4, tilt: 0, left: 0.1, right: 0.1 }; // idle
  }

  map.builders.units.mechs = (world) => {
    const { skin, root } = world,
      S = skin.sizes.robot,
      yaw = skin.camera.yaw;
    const solid = (options) =>
      new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, ...options });
    // Every part of the frame is the same unit box, stretched and tinted.
    const PARTS = 10;
    const frames = new kit.Pool(root, new T.BoxGeometry(1, 1, 1), solid(), {
        cast: true,
        receive: true,
      }),
      visors = new kit.Pool(
        root,
        new T.BoxGeometry(0.46, 0.13, 0.06),
        new T.MeshBasicMaterial({ toneMapped: false }),
      );
    const gear = Object.fromEntries(
      Object.entries(details).map(([name, build]) => [name, new kit.Pool(root, build(), solid())]),
    );
    // Far away, a unit becomes one simple marker block.
    const pawns = new kit.Pool(
      root,
      new T.CylinderGeometry(0.62, 0.85, 1.5, 6).translate(0, 0.75, 0),
      solid({ flatShading: true }),
      { cast: true },
    );
    pawns.show(false);
    const memory = new Map(), // per chat: smoothed pose and when its state last changed
      base = new T.Matrix4(),
      torso = new T.Matrix4(),
      sensor = new T.Matrix4(),
      arm = new T.Matrix4(),
      tint = new T.Color(),
      armor = new T.Color(),
      joint = new T.Color();
    let units = [],
      far = false;

    function count() {
      const used = Object.fromEntries(Object.keys(gear).map((name) => [name, 0]));
      for (const unit of units) unit.gear = used[unit.look.detail]++;
      for (const [name, pool] of Object.entries(gear)) pool.begin(far ? 0 : used[name]);
      frames.begin(far ? 0 : units.length * PARTS);
      visors.begin(far ? 0 : units.length);
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
            mind = { phase: kit.unit(id) * 10, turn: (kit.unit(`${id}t`) - 0.5) * 0.4, born: time };
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
      // True while any unit is moving, so the scene keeps drawing frames.
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
        armor.set(palette.armor);
        joint.set(palette.joint);
        units.forEach((unit, index) => {
          const mind = unit.mind,
            time = frame.time + mind.phase,
            team = unit.look.color;
          const grow =
            S * (frame.settle?.(unit) ?? (still ? 1 : kit.pop((frame.time - mind.born) / 0.4)));
          if (far) {
            const k = frame.markScale * grow * 0.8;
            pawns.put(
              index,
              kit.place(unit.x, 0, unit.z, { s: k, sy: unit.state === "idle" ? k * 0.6 : k }),
              team,
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
              ? Math.abs(Math.sin(since * 9)) * 0.3 * (1 - since / skin.timing.celebrate)
              : 0;
          let part = index * PARTS;
          const put = (parent, x, y, z, sx, sy, sz, color) =>
            frames.put(part++, kit.under(parent, x, y, z, { sx, sy, sz }), color);
          base.copy(kit.place(unit.x, mind.hop, unit.z, { ry: yaw + mind.turn, s: grow }));
          // Legs shorten when the unit crouches.
          const leg = 0.85 * (1 + now.sit * 1.6);
          put(base, -0.34, leg / 2, 0, 0.3, leg, 0.5, joint);
          put(base, 0.34, leg / 2, 0, 0.3, leg, 0.5, joint);
          torso.copy(kit.under(base, 0, leg + 0.14, 0, { rx: now.lean, rz: now.roll }));
          put(torso, 0, 0, 0, 0.98, 0.28, 0.62, joint); // hips
          put(torso, 0, 0.5, 0, 1.0, 0.72, 0.78, armor); // body
          put(torso, 0, 0.52, 0.4, 0.62, 0.4, 0.08, team); // chest plate
          put(torso, -0.7, 0.62, 0, 0.36, 0.4, 0.62, team); // shoulders
          put(torso, 0.7, 0.62, 0, 0.36, 0.4, 0.62, team);
          for (const [side, angle] of [
            [-0.7, now.left],
            [0.7, now.right],
          ]) {
            arm.copy(kit.under(torso, side, 0.5, 0, { rx: angle }));
            put(arm, 0, -0.42, 0, 0.2, 0.7, 0.24, joint);
          }
          sensor.copy(kit.under(torso, 0, 1.02, 0.04, { rx: now.head, rz: now.tilt }));
          put(sensor, 0, 0, 0, 0.56, 0.32, 0.52, armor); // sensor head
          if (unit.state === "idle" && !unit.problem) tint.set(palette.visorOff);
          else
            tint
              .copy(
                world.stateColor(
                  unit.problem && unit.state !== "needs_you" ? "problem" : unit.state,
                ),
              )
              .multiplyScalar(world.emit());
          visors.put(index, kit.under(sensor, 0, 0, 0.27), tint);
          gear[unit.look.detail].put(unit.gear, kit.under(sensor, 0, -0.1, 0, { s: 0.6 }), team);
          // The welding arm throws sparks at the end of each pass.
          if (unit.state === "working" && !unit.problem && !still) {
            const pass = Math.floor(time / skin.timing.work);
            if (mind.pass !== undefined && pass !== mind.pass) {
              const turn = yaw + mind.turn;
              world.fire("spark", {
                x: unit.x + (Math.cos(turn) * 0.7 + Math.sin(turn) * 0.75) * S,
                y: 0.85 * S,
                z: unit.z + (-Math.sin(turn) * 0.7 + Math.cos(turn) * 0.75) * S,
              });
            }
            mind.pass = pass;
          }
        });
        for (const pool of [frames, visors, pawns, ...Object.values(gear)]) pool.end();
      },
      dispose() {
        for (const pool of [frames, visors, pawns, ...Object.values(gear)]) pool.dispose();
      },
    };
  };
})();
