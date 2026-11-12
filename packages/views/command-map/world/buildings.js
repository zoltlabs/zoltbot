// Buildings: one small workshop per worktree, with the branch name on a sign beside it.
// Windows light up and the chimney steams while a chat is working there.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;

  // A gable roof: ridge along x, eaves overhanging the walls.
  function roof(w, h, d) {
    const x = w / 2,
      z = d / 2;
    const corners = {
      a: [-x, 0, z],
      b: [x, 0, z],
      c: [x, 0, -z],
      d: [-x, 0, -z],
      e: [-x, h, 0],
      f: [x, h, 0],
    };
    const faces = ["abf", "afe", "cde", "cef", "bcf", "dae"];
    const geometry = new T.BufferGeometry();
    geometry.setAttribute(
      "position",
      new T.Float32BufferAttribute(
        faces.flatMap((face) => [...face].flatMap((corner) => corners[corner])),
        3,
      ),
    );
    geometry.computeVertexNormals();
    return geometry;
  }

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

  map.builders.buildings.workshops = (world) => {
    const { skin, root } = world,
      size = skin.sizes.building,
      yaw = skin.camera.yaw;
    const solid = (options) => new T.MeshStandardMaterial({ roughness: 0.85, ...options });
    const pools = {
      walls: new kit.Pool(
        root,
        new T.RoundedBoxGeometry(size.w, size.h, size.d, 1, 0.16),
        solid(),
        {
          cast: true,
          receive: true,
        },
      ),
      roofs: new kit.Pool(
        root,
        roof(size.w + 0.7, size.roof, size.d + 0.7),
        solid({ flatShading: true, side: T.DoubleSide }),
        {
          cast: true,
        },
      ),
      chimneys: new kit.Pool(root, new T.BoxGeometry(0.6, 1.5, 0.6), solid(), { cast: true }),
      doors: new kit.Pool(root, new T.BoxGeometry(1, 1.6, 0.16), solid()),
      windows: new kit.Pool(
        root,
        new T.BoxGeometry(0.95, 0.85, 0.14),
        new T.MeshBasicMaterial({ toneMapped: false }),
      ),
      posts: new kit.Pool(root, new T.CylinderGeometry(0.07, 0.07, 1.5, 6), solid(), {
        cast: true,
      }),
    };
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

    function place() {
      if (!layout) return;
      const palette = world.palette,
        bases = layout.bases;
      for (const pool of Object.values(pools)) pool.begin(bases.length);
      pools.windows.begin(bases.length * 2);
      bases.forEach((base, index) => {
        const s = appear(base),
          lit = color.set(base.active ? palette.windowLit : palette.windowOff).clone();
        if (base.active) lit.multiplyScalar(world.emit());
        pools.walls.put(
          index,
          kit.place(base.x, (size.h / 2) * s, base.z, { s }),
          color.set(kit.pick(palette.walls, base.id)),
        );
        pools.roofs.put(
          index,
          kit.place(base.x, size.h * s, base.z, { s }),
          color.set(kit.pick(palette.roofs, base.id)),
        );
        pools.chimneys.put(
          index,
          kit.place(base.x - size.w * 0.28, (size.h + 0.9) * s, base.z - size.d * 0.2, { s }),
          color.set(palette.chimney),
        );
        pools.doors.put(
          index,
          kit.place(base.x - 1.1, 0.8 * s, base.z + size.d / 2, { s }),
          color.set(palette.door),
        );
        pools.windows.put(
          index * 2,
          kit.place(base.x + 1.05, 1.5 * s, base.z + size.d / 2, { s }),
          lit,
        );
        pools.windows.put(
          index * 2 + 1,
          kit.place(base.x + size.w / 2, 1.5 * s, base.z, { s, ry: Math.PI / 2 }),
          lit,
        );
        const [x, z] = signSpot(base);
        pools.posts.put(index, kit.place(x, 0.75 * s, z, { s }), color.set(palette.signPost));
      });
      for (const pool of Object.values(pools)) pool.end();
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
      // During the first load each workshop grows into place. `scale(base)` runs from 0 to 1.
      settle(scale) {
        appear = scale ?? (() => 1);
        words.visible = !scale;
        place();
      },
      // Chimney tops of workshops with work under way, for steam.
      chimneys: () =>
        (layout?.bases ?? [])
          .filter((base) => base.active)
          .map((base) => [base.x - size.w * 0.28, size.h + 1.7, base.z - size.d * 0.2]),
      // Where lit windows throw light on the ground at night.
      lights: () =>
        (layout?.bases ?? [])
          .filter((base) => base.active)
          .map((base) => [base.x + 1.05, base.z + size.d / 2 + 1.1]),
      footprints: () => (layout?.bases ?? []).map((base) => [base.x, base.z, size.w, size.d]),
      update() {},
      dispose() {
        for (const pool of Object.values(pools)) pool.dispose();
        root.remove(words);
        words.geometry.dispose();
        words.material.dispose();
        atlas.texture.dispose();
      },
    };
  };
})();
