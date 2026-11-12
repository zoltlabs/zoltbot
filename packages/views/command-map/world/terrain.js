// Terrain: calm water, one raised island per workspace, paths under each worktree, and a few
// trees, stones and lamps. Everything is built from the layout; nothing is loaded from a file.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = map.kit;

  function roundedRect(w, d, r) {
    const shape = new T.Shape(),
      x = -w / 2,
      y = -d / 2,
      c = Math.min(r, w / 2, d / 2);
    shape.moveTo(x + c, y);
    shape.lineTo(x + w - c, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + c);
    shape.lineTo(x + w, y + d - c);
    shape.quadraticCurveTo(x + w, y + d, x + w - c, y + d);
    shape.lineTo(x + c, y + d);
    shape.quadraticCurveTo(x, y + d, x, y + d - c);
    shape.lineTo(x, y + c);
    shape.quadraticCurveTo(x, y, x + c, y);
    return shape;
  }
  // A thick rounded slab whose top face sits at `top`.
  function slab(cx, cz, w, d, r, top, height, bevel, color) {
    const geometry = new T.ExtrudeGeometry(roundedRect(w, d, r), {
      depth: height - bevel,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 2,
      curveSegments: 5,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(cx, top - height, cz);
    return kit.paint(geometry, color);
  }
  // A flat rounded sheet lying at height `y`.
  function sheet(cx, cz, w, d, r, y, color) {
    const geometry = new T.ShapeGeometry(roundedRect(w, d, r), 5);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(cx, y, cz);
    return kit.paint(geometry, color);
  }

  map.builders.terrain.islands = (world) => {
    const { skin, root } = world,
      sizes = skin.sizes;
    const ground = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    );
    ground.receiveShadow = true;
    ground.castShadow = true;
    ground.frustumCulled = false;
    const water = new T.Mesh(
      new T.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new T.MeshStandardMaterial({ roughness: 0.45, metalness: 0 }),
    );
    water.position.y = sizes.water;
    water.receiveShadow = true;
    root.add(water, ground);

    const solid = (options) => new T.MeshStandardMaterial({ roughness: 0.9, ...options });
    const foliage = new kit.Pool(
        root,
        new T.IcosahedronGeometry(1, 1).scale(1, 1.15, 1),
        solid({ flatShading: true }),
        { cast: true, receive: true },
      ),
      trunks = new kit.Pool(root, new T.CylinderGeometry(0.14, 0.2, 1, 6), solid(), {
        cast: true,
      }),
      stones = new kit.Pool(
        root,
        new T.DodecahedronGeometry(0.5, 0).scale(1, 0.65, 1),
        solid({ flatShading: true }),
        { cast: true, receive: true },
      ),
      posts = new kit.Pool(root, new T.CylinderGeometry(0.06, 0.08, 2.1, 6), solid(), {
        cast: true,
      }),
      lamps = new kit.Pool(
        root,
        new T.SphereGeometry(0.22, 10, 8),
        new T.MeshBasicMaterial({ toneMapped: false }),
      );
    const color = new T.Color();
    let layout,
      lampSpots = [];

    function rebuild() {
      if (!layout) return;
      const palette = world.palette,
        pieces = [],
        trees = [],
        rocks = [];
      lampSpots = [];
      for (const region of layout.regions) {
        const cx = region.x + region.w / 2,
          cz = region.z + region.d / 2,
          r = sizes.islandCorner,
          skirt = sizes.skirt;
        const grass = color.set(kit.pick(palette.grass, region.id)).clone();
        pieces.push(
          sheet(
            cx,
            cz,
            region.w + 7,
            region.d + 7,
            r + 3.5,
            sizes.water + 0.05,
            color.set(palette.shallows).clone(),
          ),
          sheet(
            cx,
            cz,
            region.w + 3.6,
            region.d + 3.6,
            r + 1.8,
            sizes.water + 0.1,
            color.set(palette.foam).clone(),
          ),
          slab(
            cx,
            cz,
            region.w + skirt * 2,
            region.d + skirt * 2,
            r + skirt,
            -1.25,
            2.4,
            0.3,
            color.set(palette.rock).clone(),
          ),
          slab(cx, cz, region.w, region.d, r, -0.45, 0.9, 0, color.set(palette.soil).clone()),
          slab(cx, cz, region.w, region.d, r, 0, 0.5, 0.16, grass),
        );
        // Trees and stones stand on the grass margin, along the back and the sides.
        const step = 4.2;
        for (let along = 2.5; along < region.w - 2; along += step) {
          const key = `${region.id}:b${along}`;
          if (kit.unit(key) < 0.62)
            trees.push([
              region.x + along + kit.unit(`${key}x`) * 1.5,
              region.z + 1.5 + kit.unit(`${key}z`),
              key,
            ]);
        }
        for (let along = 5; along < region.d - 4; along += step) {
          for (const side of [0, 1]) {
            const key = `${region.id}:s${side}${along}`,
              x = side ? region.x + region.w - 1.6 : region.x + 1.6;
            if (kit.unit(key) < 0.4) trees.push([x, region.z + along + kit.unit(`${key}z`), key]);
            else if (kit.unit(key) > 0.86) rocks.push([x, region.z + along, key]);
          }
        }
        lampSpots.push(
          [region.x + 1.7, region.z + region.d - 1.7],
          [region.x + region.w - 1.7, region.z + region.d - 1.7],
        );
      }
      for (const cell of layout.cells)
        pieces.push(
          sheet(
            cell.x + cell.w / 2,
            cell.z + cell.d / 2,
            cell.w + 0.6,
            cell.d + 0.6,
            1.2,
            0.03,
            color.set(palette.path).clone(),
          ),
        );
      ground.geometry.dispose();
      ground.geometry = pieces.length ? kit.join(pieces) : new T.BufferGeometry();
      water.material.color.set(palette.water);

      foliage.begin(trees.length);
      trunks.begin(trees.length);
      trees.forEach(([x, z, key], index) => {
        const height = 0.9 + kit.unit(`${key}h`) * 0.7,
          spread = 0.85 + kit.unit(`${key}w`) * 0.5;
        trunks.put(index, kit.place(x, height / 2, z, { sy: height }), color.set(palette.trunk));
        foliage.put(
          index,
          kit.place(x, height + spread * 0.75, z, { s: spread, ry: kit.unit(key) * 6 }),
          color.set(kit.pick(palette.foliage, key)),
        );
      });
      foliage.end();
      trunks.end();
      stones.begin(rocks.length);
      rocks.forEach(([x, z, key], index) => {
        stones.put(
          index,
          kit.place(x, 0.2, z, { s: 0.7 + kit.unit(key) * 0.8, ry: kit.unit(key) * 6 }),
          color.set(palette.stone),
        );
      });
      stones.end();
      posts.begin(lampSpots.length);
      lamps.begin(lampSpots.length);
      lampSpots.forEach(([x, z], index) => {
        posts.put(index, kit.place(x, 1.05, z), color.set(palette.signPost));
        lamps.put(
          index,
          kit.place(x, 2.2, z),
          color.set(palette.lampLit).multiplyScalar(palette.emit),
        );
      });
      posts.end();
      lamps.end();
    }
    return {
      setData(next) {
        const signature = JSON.stringify([next.regions, next.cells]);
        layout = next;
        if (signature === this.signature) return;
        this.signature = signature;
        rebuild();
      },
      theme: rebuild,
      // Where light pools go at night; the effects builder reads this.
      lights: () => lampSpots,
      update() {},
      dispose() {
        root.remove(water, ground);
        ground.geometry.dispose();
        ground.material.dispose();
        water.geometry.dispose();
        water.material.dispose();
        for (const pool of [foliage, trunks, stones, posts, lamps]) pool.dispose();
      },
    };
  };
})();
