// Buildings: one fabrication bay per worktree, with the branch name on a lit sign beside it.
// Its light strips come on and its stack vents while a chat is working there.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;

  // Sign text is drawn once into a shared canvas; each sign shows its own cell of it.
  const CELL = { w: 256, h: 64, columns: 8, rows: 32 };
  function signAtlas() {
    const canvas = document.createElement("canvas");
    canvas.width = CELL.w * CELL.columns;
    canvas.height = CELL.h * CELL.rows;
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 4;
    return { canvas, texture, context: canvas.getContext("2d") };
  }
  function fitText(context, text, width) {
    if (context.measureText(text).width <= width) return text;
    let short = text;
    while (short.length > 1 && context.measureText(`${short}…`).width > width)
      short = short.slice(0, -1);
    return `${short}…`;
  }

  map.builders.buildings.facilities = (world) => {
    const { skin, root } = world,
      size = skin.sizes.building,
      yaw = skin.camera.yaw;
    const solid = (options) =>
      new T.MeshStandardMaterial({ roughness: 0.7, metalness: 0.15, ...options });
    // Every structural part is the same unit box, stretched; lights are a second set.
    const blocks = new kit.Pool(root, new T.BoxGeometry(1, 1, 1), solid(), {
        cast: true,
        receive: true,
      }),
      lights = new kit.Pool(
        root,
        new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ toneMapped: false }),
      );
    const BLOCKS = 9,
      LIGHTS = 3;
    const atlas = signAtlas();
    const words = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshStandardMaterial({
        map: atlas.texture,
        emissiveMap: atlas.texture,
        emissive: "#ffffff",
        side: T.DoubleSide,
        roughness: 0.9,
      }),
    );
    words.frustumCulled = false;
    words.castShadow = true;
    root.add(words);
    const color = new T.Color(),
      board = new T.Matrix4();
    let layout,
      appear = () => 1;

    // Paints every sign (board, edge and branch name) into the atlas and builds one quad each.
    function writeSigns(bases) {
      const { context, canvas } = atlas,
        palette = world.palette,
        positions = [],
        uvs = [];
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = "600 34px system-ui, -apple-system, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineWidth = 4;
      bases.slice(0, CELL.columns * CELL.rows).forEach((base, index) => {
        const column = index % CELL.columns,
          row = Math.floor(index / CELL.columns),
          left = column * CELL.w,
          top = row * CELL.h;
        context.fillStyle = palette.signBoard;
        context.strokeStyle = palette.signPost;
        context.beginPath();
        context.roundRect(left + 4, top + 4, CELL.w - 8, CELL.h - 8, 8);
        context.fill();
        context.stroke();
        context.fillStyle = palette.signInk;
        context.fillText(
          fitText(context, base.name, CELL.w - 28),
          left + CELL.w / 2,
          top + CELL.h / 2 + 2,
        );
        const u0 = column / CELL.columns,
          u1 = (column + 1) / CELL.columns,
          v1 = 1 - row / CELL.rows,
          v0 = 1 - (row + 1) / CELL.rows;
        const corners = [
          [-1.3, -0.34, u0, v0],
          [1.3, -0.34, u1, v0],
          [1.3, 0.34, u1, v1],
          [-1.3, 0.34, u0, v1],
        ].map(([x, y, u, v]) => ({
          point: new T.Vector3(x, y, 0).applyMatrix4(signMatrix(base, board)),
          u,
          v,
        }));
        for (const corner of [0, 1, 2, 0, 2, 3]) {
          positions.push(...corners[corner].point.toArray());
          uvs.push(corners[corner].u, corners[corner].v);
        }
      });
      atlas.texture.needsUpdate = true;
      words.geometry.dispose();
      words.geometry = new T.BufferGeometry();
      words.geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      words.geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
      words.geometry.computeVertexNormals();
      // By night the sign keeps a little light of its own so the name stays readable.
      words.material.emissiveIntensity = palette.signGlow;
    }
    // The sign stands at the front right corner, turned and tilted to face the camera.
    const signSpot = (base) => [base.x + size.w / 2 + 1.5, base.z + size.d / 2 + 0.2];
    function signMatrix(base, target) {
      const [x, z] = signSpot(base);
      return target.copy(kit.place(x, 1.55, z, { ry: yaw, rx: -0.5 }));
    }

    // The stack at the back right of the roof, where exhaust rises.
    const stackSpot = (base) => [base.x + size.w * 0.3, base.z - size.d * 0.22];
    function place() {
      if (!layout) return;
      const palette = world.palette,
        bases = layout.bases,
        { w, h, d } = size;
      blocks.begin(bases.length * BLOCKS);
      lights.begin(bases.length * LIGHTS);
      bases.forEach((base, index) => {
        const s = appear(base),
          { x, z } = base,
          hull = color.set(kit.pick(palette.hull, base.id)).clone(),
          dark = color.set(palette.hullDark).clone(),
          lit = color.set(base.active ? palette.bayLit : palette.bayOff).clone();
        if (base.active) lit.multiplyScalar(world.emit());
        const [stackX, stackZ] = stackSpot(base),
          [signX, signZ] = signSpot(base);
        // Each row: center x, y, z, then width, height, depth, then color.
        const parts = [
          [x, h / 2, z, w, h, d, hull], // main hall
          [x - w * 0.2, h + 0.4, z - d * 0.12, w * 0.5, 0.8, d * 0.6, dark], // upper deck
          [x, h + 0.06, z, w + 0.3, 0.12, d + 0.3, hull], // roof lip
          [x - w * 0.12, 0.85, z + d / 2, 2.5, 1.7, 0.12, color.set(palette.door).clone()], // bay door
          [x + w / 2 - 0.5, 0.6, z + d / 2 + 0.25, 0.7, 1.2, 0.5, dark], // power unit by the door
          [stackX, h + 0.75, stackZ, 0.55, 1.5, 0.55, color.set(palette.stack).clone()], // stack
          [x - w * 0.36, h + 1.6, z - d * 0.3, 0.08, 1.6, 0.08, dark], // antenna mast
          [x - w * 0.36, h + 2.2, z - d * 0.3, 0.5, 0.06, 0.06, dark], // antenna crossbar
          [signX, 0.75, signZ, 0.12, 1.5, 0.12, color.set(palette.signPost).clone()], // sign post
        ];
        parts.forEach(([px, py, pz, sx, sy, sz, tint], part) => {
          blocks.put(
            index * BLOCKS + part,
            kit.place(px, py * s, pz, { sx: sx * s, sy: sy * s, sz: sz * s }),
            tint,
          );
        });
        const strips = [
          [x - w * 0.12, 1.85, z + d / 2 + 0.02, 2.5, 0.14, 0.1], // over the bay door
          [x + w / 2 + 0.02, 1.5, z, 0.1, 0.14, d * 0.6], // along the side
          [x + w / 2 - 0.5, 1.05, z + d / 2 + 0.51, 0.4, 0.14, 0.04], // on the power unit
        ];
        strips.forEach(([px, py, pz, sx, sy, sz], part) => {
          lights.put(
            index * LIGHTS + part,
            kit.place(px, py * s, pz, { sx: sx * s, sy: sy * s, sz: sz * s }),
            lit,
          );
        });
      });
      blocks.end();
      lights.end();
    }
    return {
      setData(next) {
        const names = JSON.stringify(next.bases.map((base) => [base.name, base.x, base.z]));
        layout = next;
        if (names !== this.names) writeSigns(next.bases);
        this.names = names;
        place();
      },
      theme() {
        if (layout) writeSigns(layout.bases);
        place();
      },
      // During the first load each structure grows into place. `scale(base)` runs from 0 to 1.
      settle(scale) {
        appear = scale ?? (() => 1);
        words.visible = !scale;
        place();
      },
      // Stack tops of bays with work under way, for exhaust.
      chimneys: () =>
        (layout?.bases ?? [])
          .filter((base) => base.active)
          .map((base) => [stackSpot(base)[0], size.h + 1.6, stackSpot(base)[1]]),
      // Where the lit bay door throws light on the ground at night.
      lights: () =>
        (layout?.bases ?? [])
          .filter((base) => base.active)
          .map((base) => [base.x - size.w * 0.12, base.z + size.d / 2 + 1.2]),
      footprints: () => (layout?.bases ?? []).map((base) => [base.x, base.z, size.w, size.d]),
      update() {},
      dispose() {
        blocks.dispose();
        lights.dispose();
        root.remove(words);
        words.geometry.dispose();
        words.material.dispose();
        atlas.texture.dispose();
      },
    };
  };
})();
