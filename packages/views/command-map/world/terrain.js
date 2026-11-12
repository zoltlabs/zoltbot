// Terrain: bare ground with a survey grid, one raised steel platform per workspace, a marked
// bay for each worktree, and a few crates and light pylons. Everything is built from the
// layout; nothing is loaded from a file.
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

  // The survey grid: one cell of faint lines, repeated across the ground.
  function gridTexture(palette) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    context.fillStyle = palette.ground;
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = palette.gridLine;
    context.lineWidth = 2;
    context.strokeRect(0, 0, 128, 128);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  }

  map.builders.terrain.platforms = (world) => {
    const { skin, root } = world,
      sizes = skin.sizes;
    const decks = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.15 }),
    );
    decks.receiveShadow = true;
    decks.castShadow = true;
    decks.frustumCulled = false;
    const ground = new T.Mesh(
      new T.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new T.MeshStandardMaterial({ roughness: 1 }),
    );
    ground.position.y = sizes.ground;
    ground.receiveShadow = true;
    root.add(ground, decks);

    const solid = (options) => new T.MeshStandardMaterial({ roughness: 0.75, ...options });
    const crates = new kit.Pool(root, new T.BoxGeometry(1, 1, 1), solid(), {
        cast: true,
        receive: true,
      }),
      pylons = new kit.Pool(root, new T.BoxGeometry(0.16, 2.6, 0.16), solid(), { cast: true }),
      lamps = new kit.Pool(
        root,
        new T.BoxGeometry(0.5, 0.16, 0.3),
        new T.MeshBasicMaterial({ toneMapped: false }),
      );
    const color = new T.Color(),
      tone = (value) => color.set(value).clone();
    let layout,
      lampSpots = [];

    function rebuild() {
      const palette = world.palette;
      ground.material.map?.dispose();
      ground.material.map = gridTexture(palette);
      ground.material.map.repeat.setScalar(4000 / sizes.grid);
      ground.material.needsUpdate = true;
      if (!layout) return;
      const pieces = [],
        boxes = [];
      lampSpots = [];
      for (const region of layout.regions) {
        const cx = region.x + region.w / 2,
          cz = region.z + region.d / 2,
          r = sizes.platformCorner,
          skirt = sizes.skirt;
        pieces.push(
          // A stepped base, the deck, a painted line around its edge, then the deck again inside it.
          slab(
            cx,
            cz,
            region.w + skirt * 2,
            region.d + skirt * 2,
            r + skirt,
            -0.45,
            1.1,
            0,
            tone(palette.deckEdge),
          ),
          slab(cx, cz, region.w, region.d, r, 0, 0.6, 0.1, tone(kit.pick(palette.deck, region.id))),
          sheet(
            cx,
            cz,
            region.w - 0.5,
            region.d - 0.5,
            r,
            0.02,
            tone(kit.pick(palette.trim, region.id)),
          ),
          sheet(
            cx,
            cz,
            region.w - 1,
            region.d - 1,
            r,
            0.03,
            tone(kit.pick(palette.deck, region.id)),
          ),
        );
        // Seams between deck plates.
        for (let x = 6; x < region.w - 3; x += 6)
          pieces.push(
            sheet(region.x + x, cz, 0.1, region.d - 1.4, 0, 0.035, tone(palette.deckLine)),
          );
        for (let z = 6; z < region.d - 3; z += 6)
          pieces.push(
            sheet(cx, region.z + z, region.w - 1.4, 0.1, 0, 0.035, tone(palette.deckLine)),
          );
        // Supply crates stand on the margin, along the back and the sides.
        for (let along = 3; along < region.w - 3; along += 4.5) {
          const key = `${region.id}:b${along}`;
          if (kit.unit(key) < 0.4) boxes.push([region.x + along, region.z + 1.5, key]);
        }
        for (let along = 6; along < region.d - 4; along += 4.5)
          for (const side of [0, 1]) {
            const key = `${region.id}:s${side}${along}`;
            if (kit.unit(key) < 0.3)
              boxes.push([
                side ? region.x + region.w - 1.5 : region.x + 1.5,
                region.z + along,
                key,
              ]);
          }
        lampSpots.push(
          [region.x + 1.4, region.z + region.d - 1.4],
          [region.x + region.w - 1.4, region.z + region.d - 1.4],
        );
      }
      // Each worktree's bay: a dark pad with a painted outline.
      for (const cell of layout.cells) {
        const x = cell.x + cell.w / 2,
          z = cell.z + cell.d / 2;
        pieces.push(
          sheet(x, z, cell.w + 0.5, cell.d + 0.5, 0.5, 0.045, tone(palette.padLine)),
          sheet(x, z, cell.w + 0.24, cell.d + 0.24, 0.4, 0.055, tone(palette.pad)),
        );
      }
      decks.geometry.dispose();
      decks.geometry = pieces.length ? kit.join(pieces) : new T.BufferGeometry();

      // One or two crates per spot, the second stacked on the first.
      const stacked = boxes.flatMap(([x, z, key]) =>
        kit.unit(`${key}s`) < 0.45
          ? [
              [x, 0.45, z, key, 0.9],
              [x + 0.1, 1.25, z - 0.05, `${key}t`, 0.7],
            ]
          : [[x, 0.45, z, key, 0.9]],
      );
      crates.begin(stacked.length);
      stacked.forEach(([x, y, z, key, size], index) => {
        crates.put(
          index,
          kit.place(x, y, z, {
            s: size,
            sx: size * (1 + kit.unit(`${key}w`) * 0.6),
            ry: kit.unit(key) * 0.5,
          }),
          color.set(kit.pick(palette.crate, key)),
        );
      });
      crates.end();
      pylons.begin(lampSpots.length);
      lamps.begin(lampSpots.length);
      lampSpots.forEach(([x, z], index) => {
        pylons.put(index, kit.place(x, 1.3, z), color.set(palette.signPost));
        lamps.put(
          index,
          kit.place(x, 2.6, z, { ry: skin.camera.yaw }),
          color.set(palette.lampLit).multiplyScalar(world.emit()),
        );
      });
      pylons.end();
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
        root.remove(ground, decks);
        decks.geometry.dispose();
        decks.material.dispose();
        ground.geometry.dispose();
        ground.material.map?.dispose();
        ground.material.dispose();
        for (const pool of [crates, pylons, lamps]) pool.dispose();
      },
    };
  };
})();
